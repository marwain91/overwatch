#!/usr/bin/env node
import { runInit } from './cli/init';
import { runUpdate } from './cli/update';
import { runStart, runStop, runRestart, runRecreate, runStatus } from './cli/lifecycle';
import { runConfig } from './cli/config';
import { runSelfUpdate } from './cli/self-update';
import { runAdmins } from './cli/admins';
import { VERSION } from './version';

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

  case 'config':
    run(runConfig);
    break;

  case 'update':
    run(runUpdate);
    break;

  case 'self-update':
    run(runSelfUpdate);
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

  case 'recreate':
    run(() => runRecreate());
    break;

  case 'status':
    run(() => runStatus());
    break;

  case 'admins':
    run(runAdmins);
    break;

  case '--version':
  case '-v':
    console.log(VERSION);
    break;

  case undefined:
  case '--help':
  case '-h':
    console.log('');
    console.log(`  \x1b[1mOverwatch CLI\x1b[0m v${VERSION}`);
    console.log('');
    console.log('  Usage: overwatch <command>');
    console.log('');
    console.log('  Commands:');
    console.log('    init                    Set up a new Overwatch deployment interactively');
    console.log('    start                   Start infrastructure + Overwatch');
    console.log('    stop                    Stop Overwatch + infrastructure');
    console.log('    restart                 Restart all services');
    console.log('    recreate                Force-recreate Overwatch containers');
    console.log('    status                  Show service status');
    console.log('    admins                  List, add, or remove admin users');
    console.log('    config                  View, edit, validate, and explore configuration');
    console.log('    update [--check]        Pull latest image and restart (--self-update to also update CLI)');
    console.log('    self-update [--check]   Update the CLI binary itself');
    console.log('');
    console.log('  Environment:');
    console.log('    OVERWATCH_CONFIG        Path to overwatch.yaml (auto-detected if not set)');
    console.log('    DEPLOY_DIR              Path to deploy root (auto-detected if not set)');
    console.log('');
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "overwatch --help" for usage.');
    process.exit(1);
}
