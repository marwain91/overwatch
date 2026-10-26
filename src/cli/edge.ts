import { loadConfig } from '../config';
import { deployEdge, rollbackEdge } from '../services/edgeDeploy';
import { renderEdgeNginx } from '../services/edgeNginx';

export async function runEdge(args: string[]): Promise<void> {
  const command=args[0];
  if(!command||command==='--help'||command==='-h'){
    console.log('overwatch infra edge render|check|deploy|rollback <backup-id>');
    console.log('  Optional: --nginx-dir /etc/nginx --nginx-binary nginx');
    console.log('  render prints config; check validates without applying; deploy backs up, validates and reloads.');
    return;
  }
  const options:{nginxDir?:string;nginxBinary?:string}={};
  const rest=args.slice(1);let backupId:string|undefined;
  for(let i=0;i<rest.length;i++){
    if(rest[i]==='--nginx-dir'||rest[i]==='--nginx-binary'){
      const key=rest[i]==='--nginx-dir'?'nginxDir':'nginxBinary';
      if(!rest[i+1]||rest[i+1].startsWith('--'))throw new Error(`Missing value for ${rest[i]}`);
      options[key]=rest[++i];
    }else if(command==='rollback'&&!backupId&&!rest[i].startsWith('-'))backupId=rest[i];
    else throw new Error(`Unexpected argument: ${rest[i]}`);
  }
  if(command==='rollback'){
    if(!backupId)throw new Error('A backup ID is required');
    await rollbackEdge(backupId,options);console.log('Previous Nginx configuration restored and reloaded');return;
  }
  if(!['render','check','deploy'].includes(command))throw new Error(`Unknown edge command: ${command}`);
  const edge=loadConfig().edge;
  if(!edge?.enabled)throw new Error('Configure edge.enabled: true in overwatch.yaml first');
  if(command==='render'){process.stdout.write(renderEdgeNginx(edge));return;}
  const result=await deployEdge(edge,{...options,checkOnly:command==='check'});
  console.log(command==='check'?'Candidate Nginx configuration is valid; no live files changed':result.changed?'Managed edge installed and Nginx reloaded':'Managed edge is unchanged; Nginx configuration is valid');
  if(result.backup)console.log(`Rollback backup: ${result.backup}`);
}
