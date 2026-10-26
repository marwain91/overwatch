import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import type { EdgeConfig } from '../models/edge';
import { renderEdgeNginx, EDGE_MANAGED_MARKER } from './edgeNginx';
import { withFileLock } from './fileLock';

const exec = promisify(execFile);
const MANAGED = 'overwatch-edge.conf';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file,'utf8'); } catch(e:any) { if(e.code==='ENOENT')return null;throw e; }
}
async function snapshot(dir: string): Promise<Record<string,string>> {
  const result: Record<string,string> = {};
  for(const name of (await fs.readdir(dir)).filter(n=>n.endsWith('.conf')).sort()) result[name]=digest(await fs.readFile(path.join(dir,name),'utf8'));
  return result;
}
async function atomic(file: string, text: string, mode = 0o644): Promise<void> {
  const temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,text,{mode});
  await fs.rename(temp,file);
}
async function nginx(binary: string, args: string[]) {
  // No shell; no process secrets are passed to Nginx. Bound a stuck check/reload.
  const result=await exec(binary,args,{timeout:30_000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,LANG:'C'}});
  if(/conflicting server name/i.test(result.stderr))throw new Error('Nginx reports conflicting server names; explicitly adopt the old virtual host files first');
  return result;
}
export interface EdgeDeployOptions { nginxDir?: string; nginxBinary?: string; checkOnly?: boolean }

/** Validate the complete candidate, adopt only explicitly listed files, and rollback on failure. */
export async function deployEdge(edge: EdgeConfig, options: EdgeDeployOptions = {}): Promise<{backup: string | null; changed: boolean}> {
  const rendered=renderEdgeNginx(edge);
  const dir=path.resolve(options.nginxDir ?? '/etc/nginx');
  const binary=options.nginxBinary ?? 'nginx';
  return withFileLock('edge-nginx-deploy', async()=>{
    const confDir=path.join(dir,'conf.d');
    const target=path.join(confDir,MANAGED);
    const old=await readOptional(target);
    if(old !== null && !old.startsWith(EDGE_MANAGED_MARKER+'\n')) throw new Error('Refusing to replace an unmanaged overwatch-edge.conf');
    const touched=[MANAGED,...edge.adopt_files];
    for(const name of touched) {
      try { if((await fs.lstat(path.join(confDir,name))).isSymbolicLink())throw new Error(`Refusing to adopt symlink ${name}`); }
      catch(e:any){if(e.code!=='ENOENT')throw e;}
    }
    const before=await snapshot(confDir);
    const liveConfig=path.join(dir,'nginx.conf');
    const main=await fs.readFile(liveConfig,'utf8');
    // Require one standard http-context conf.d include. Arbitrary existing main configs are not rewritten.
    const include=new RegExp(`^[ \\t]*include[ \\t]+["']?${confDir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/\\*\\.conf["']?[ \\t]*;[ \\t]*(?:#[^\\n]*)?$`,'gm');
    if([...main.matchAll(include)].length!==1)throw new Error(`Expected exactly one include ${confDir}/*.conf in nginx.conf`);
    const changed=old!==rendered || edge.adopt_files.some(n=>before[n]!==undefined);
    if(!changed){await nginx(binary,['-t','-c',liveConfig]);return {backup:null,changed:false};}
    const root=path.join(dir,'.overwatch-edge');
    await fs.mkdir(root,{recursive:true,mode:0o700});
    const backup=path.join(root,`${Date.now()}-${randomUUID()}`);
    await fs.mkdir(backup,{mode:0o700});
    await fs.cp(confDir,path.join(backup,'before'),{recursive:true});
    await fs.writeFile(path.join(backup,'nginx.conf.before'),main,{mode:0o600});
    const candidate=path.join(backup,'candidate');
    await fs.cp(confDir,candidate,{recursive:true});
    for(const name of edge.adopt_files)await fs.rm(path.join(candidate,name),{force:true});
    await fs.writeFile(path.join(candidate,MANAGED),rendered,{mode:0o644});
    const stagedMain=path.join(backup,'nginx.conf');
    await fs.writeFile(stagedMain,main.replace(include,`    include ${JSON.stringify(candidate+'/*.conf')};`),{mode:0o600});
    try {
      await nginx(binary,['-t','-c',stagedMain]);
      if(options.checkOnly)return {backup:null,changed:true};
      if(JSON.stringify(await snapshot(confDir))!==JSON.stringify(before) || await fs.readFile(liveConfig,'utf8')!==main)throw new Error('Nginx configuration changed during validation; retry');
      const manifest={files:touched,before,installed:digest(rendered),at:new Date().toISOString()};
      await fs.writeFile(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
      try {
        await atomic(target,rendered);
        for(const name of edge.adopt_files)await fs.rm(path.join(confDir,name),{force:true});
        await nginx(binary,['-t','-c',liveConfig]);
        await nginx(binary,['-s','reload','-c',liveConfig]);
      } catch(error) {
        for(const name of touched){const source=path.join(backup,'before',name);const text=await readOptional(source);if(text===null)await fs.rm(path.join(confDir,name),{force:true});else await atomic(path.join(confDir,name),text,(await fs.stat(source)).mode & 0o777);}
        try {await nginx(binary,['-t','-c',liveConfig]);await nginx(binary,['-s','reload','-c',liveConfig]);}catch(recovery:any){throw new Error(`${(error as Error).message}; files restored but rollback reload failed: ${recovery.message}. Backup: ${backup}`);}
        throw error;
      }
      return {backup,changed:true};
    } finally { if(options.checkOnly)await fs.rm(backup,{recursive:true,force:true}); }
  });
}

/** Restore one deployment's adopted files; refuse to overwrite subsequent manual changes. */
export async function rollbackEdge(backupId: string, options: EdgeDeployOptions = {}): Promise<void> {
  if(!/^[0-9]+-[a-f0-9-]{36}$/.test(backupId))throw new Error('Expected a backup ID printed by edge deploy');
  const dir=path.resolve(options.nginxDir ?? '/etc/nginx');
  const binary=options.nginxBinary ?? 'nginx';
  await withFileLock('edge-nginx-deploy',async()=>{
    const backup=path.join(dir,'.overwatch-edge',backupId);
    const manifest=JSON.parse(await fs.readFile(path.join(backup,'manifest.json'),'utf8')) as {files:string[];installed:string};
    if(!Array.isArray(manifest.files)||manifest.files.some(n=>!/^[-a-zA-Z0-9_]+\.conf$/.test(n)))throw new Error('Invalid backup manifest');
    const target=path.join(dir,'conf.d',MANAGED);
    if(digest(await fs.readFile(target,'utf8'))!==manifest.installed)throw new Error('Managed config changed since this deployment; refusing rollback');
    for(const name of manifest.files.filter(n=>n!==MANAGED))if(await readOptional(path.join(dir,'conf.d',name))!==null)throw new Error(`File ${name} was recreated after deployment; refusing rollback`);
    const installed=await fs.readFile(target,'utf8');
    try {
      for(const name of manifest.files){const source=path.join(backup,'before',name);const old=await readOptional(source);if(old===null)await fs.rm(path.join(dir,'conf.d',name),{force:true});else await atomic(path.join(dir,'conf.d',name),old,(await fs.stat(source)).mode & 0o777);}
      await nginx(binary,['-t','-c',path.join(dir,'nginx.conf')]);
      await nginx(binary,['-s','reload','-c',path.join(dir,'nginx.conf')]);
    }catch(error){
      for(const name of manifest.files.filter(n=>n!==MANAGED))await fs.rm(path.join(dir,'conf.d',name),{force:true});
      await atomic(target,installed);
      try {await nginx(binary,['-t','-c',path.join(dir,'nginx.conf')]);await nginx(binary,['-s','reload','-c',path.join(dir,'nginx.conf')]);}catch{/* Keep original error. */}
      throw error;
    }
  });
}
