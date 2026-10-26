import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
const {run}=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('node:child_process',()=>({execFile:run}));
vi.mock('../services/fileLock',()=>({withFileLock:async(_key:string,fn:()=>unknown)=>fn()}));
import { deployEdge,rollbackEdge } from '../services/edgeDeploy';
import { EdgeConfigSchema } from '../models/edge';
let root:string;
const config=()=>EdgeConfigSchema.parse({enabled:true,tls:{certificate:'/cert/test.crt',certificate_key:'/cert/test.key'},adopt_files:['old.conf'],sites:[{name:'product',host:'product.example.com',access_control:{default_action:'deny',rules:[]}}]});
beforeEach(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'edge-deploy-'));await fs.mkdir(path.join(root,'conf.d'));
 await fs.writeFile(path.join(root,'nginx.conf'),`events {}\nhttp {\n include ${root}/conf.d/*.conf;\n}\n`);
 await fs.writeFile(path.join(root,'conf.d','old.conf'),'# original');
 run.mockReset();run.mockImplementation((_bin:any,_args:any,_opts:any,cb:any)=>cb(null,{stdout:'',stderr:''}));
});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
describe('edge deployment transactions',()=>{
 it('checks without changing live files or retaining a candidate backup',async()=>{
  const r=await deployEdge(config(),{nginxDir:root,checkOnly:true});expect(r.backup).toBe(null);
  expect(await fs.readdir(path.join(root,'conf.d'))).toEqual(['old.conf']);expect(await fs.readdir(path.join(root,'.overwatch-edge'))).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
 });
 it('validates before installing, preserves unrelated files, and supports rollback',async()=>{
  await fs.writeFile(path.join(root,'conf.d','unrelated.conf'),'# untouched');
  const r=await deployEdge(config(),{nginxDir:root});expect(r.changed).toBe(true);
  expect(await fs.readFile(path.join(root,'conf.d','unrelated.conf'),'utf8')).toBe('# untouched');
  expect(await fs.readFile(path.join(r.backup!,'before','old.conf'),'utf8')).toBe('# original');
  expect(run.mock.calls[0][1][0]).toBe('-t');expect(run.mock.calls[2][1].slice(0,2)).toEqual(['-s','reload']);
  await rollbackEdge(path.basename(r.backup!),{nginxDir:root});
  expect(await fs.readFile(path.join(root,'conf.d','old.conf'),'utf8')).toBe('# original');
  expect(await fs.readdir(path.join(root,'conf.d'))).toEqual(['old.conf','unrelated.conf']);
 });
 it('refuses unmanaged target files and adoption symlinks',async()=>{
  await fs.writeFile(path.join(root,'conf.d','overwatch-edge.conf'),'# human owned');
  await expect(deployEdge(config(),{nginxDir:root})).rejects.toThrow('unmanaged');
  await fs.rm(path.join(root,'conf.d','overwatch-edge.conf'));await fs.rm(path.join(root,'conf.d','old.conf'));
  await fs.symlink(path.join(root,'nginx.conf'),path.join(root,'conf.d','old.conf'));
  await expect(deployEdge(config(),{nginxDir:root})).rejects.toThrow('symlink');
 });
 it('leaves the original live configuration intact when candidate validation fails',async()=>{
  run.mockImplementation((_b:any,_a:any,_o:any,cb:any)=>cb(new Error('invalid config')));
  await expect(deployEdge(config(),{nginxDir:root})).rejects.toThrow('invalid config');
  expect(await fs.readdir(path.join(root,'conf.d'))).toEqual(['old.conf']);
 });
 it('treats ignored conflicting virtual hosts as a failed validation',async()=>{
  run.mockImplementation((_b:any,_a:any,_o:any,cb:any)=>cb(null,{stdout:'',stderr:'[warn] conflicting server name "product.example.com" ignored'}));
  await expect(deployEdge(config(),{nginxDir:root})).rejects.toThrow('conflicting');
  expect(await fs.readdir(path.join(root,'conf.d'))).toEqual(['old.conf']);
 });
 it('rolls back installed files if reload fails',async()=>{
  run.mockImplementationOnce((_b:any,_a:any,_o:any,cb:any)=>cb(null,{stdout:'',stderr:''}))
   .mockImplementationOnce((_b:any,_a:any,_o:any,cb:any)=>cb(null,{stdout:'',stderr:''}))
   .mockImplementationOnce((_b:any,_a:any,_o:any,cb:any)=>cb(new Error('reload failed')));
  await expect(deployEdge(config(),{nginxDir:root})).rejects.toThrow('reload failed');
  expect(await fs.readdir(path.join(root,'conf.d'))).toEqual(['old.conf']);
  expect(await fs.readFile(path.join(root,'conf.d','old.conf'),'utf8')).toBe('# original');
 });
 it('does not reload on an unchanged deployment',async()=>{
  await deployEdge(config(),{nginxDir:root});run.mockClear();
  expect(await deployEdge(config(),{nginxDir:root})).toEqual({backup:null,changed:false});expect(run).toHaveBeenCalledTimes(1);
 });
 it('preserves restrictive original file permissions on rollback',async()=>{
  await fs.chmod(path.join(root,'conf.d','old.conf'),0o600);
  const r=await deployEdge(config(),{nginxDir:root});
  await rollbackEdge(path.basename(r.backup!),{nginxDir:root});
  expect((await fs.stat(path.join(root,'conf.d','old.conf'))).mode & 0o777).toBe(0o600);
 });
 it('refuses rollback after manual changes and disallows backup traversal',async()=>{
  const r=await deployEdge(config(),{nginxDir:root});
  await fs.appendFile(path.join(root,'conf.d','overwatch-edge.conf'),'# manual');
  await expect(rollbackEdge(path.basename(r.backup!),{nginxDir:root})).rejects.toThrow('changed');
  await expect(rollbackEdge('../elsewhere',{nginxDir:root})).rejects.toThrow('backup ID');
 });
 it('detects concurrent changes made while validation runs',async()=>{
  run.mockImplementationOnce((_b:any,_a:any,_o:any,cb:any)=>{fs.writeFile(path.join(root,'conf.d','added.conf'),'# concurrent').then(()=>cb(null,{stdout:'',stderr:''}));});
  await expect(deployEdge(config(),{nginxDir:root})).rejects.toThrow('changed during validation');
  expect(await fs.readFile(path.join(root,'conf.d','old.conf'),'utf8')).toBe('# original');
 });
});
