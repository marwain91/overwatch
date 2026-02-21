#!/usr/bin/env node
import { runInit } from './cli/init';
import { runUpdate } from './cli/update';
import { runStart, runStop, runRestart, runStatus } from './cli/lifecycle';

const command = process.argv[2];
const args = process.argv.slice(3);

const run = (fn: (args: string[]) => Promise<void>) =>
  fn(args).catch((err: Error) => {
    console.error(`\n\x1b[31mError:\x1b[0m ${err.message}\n`);
    process.exit(1);
  });

switch (command) {
  case 'init':
    run(() => runInit());
    break;

  case 'update':
    run(runUpdate);
    break;

  case 'start':
    run(() => runStart());
    break;

  case 'stop':
    run(() => runStop());
    break;

  case 'restart':
    run(() => runRestart());
    break;

  case 'status':
    run(() => runStatus());
    break;

  case undefined:
  case '--help':
  case '-h':
    console.log('');
    console.log('  \x1b[1mOverwatch CLI\x1b[0m');
    console.log('');
    console.log('  Usage: overwatch <command>');
    console.log('');
    console.log('  Commands:');
    console.log('    init              Set up a new Overwatch deployment interactively');
    console.log('    start             Start infrastructure + Overwatch');
    console.log('    stop              Stop Overwatch + infrastructure');
    console.log('    restart           Restart all services');
    console.log('    status            Show service status');
    console.log('    update [--check]  Pull latest image and restart (--check to only check)');
    console.log('');
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "overwatch --help" for usage.');
    process.exit(1);
}
