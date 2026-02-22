import inquirer from 'inquirer';
import { runConfigView } from './view';
import { runConfigEdit } from './edit';
import { runConfigDocs } from './docs';
import { runConfigValidate } from './validate';
import { BOLD, CYAN, NC, DIM } from './utils';

export async function runConfig(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === '--help' || subcommand === '-h') {
    showHelp();
    return;
  }

  switch (subcommand) {
    case 'view':
      return runConfigView(args.slice(1));
    case 'edit':
      return runConfigEdit(args.slice(1));
    case 'docs':
      return runConfigDocs(args.slice(1));
    case 'validate':
      return runConfigValidate(args.slice(1));
    case undefined:
      return showMenu();
    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error('Run "overwatch config --help" for usage.');
      process.exit(1);
  }
}

function showHelp(): void {
  console.log('');
  console.log(`  ${BOLD}overwatch config${NC} — Browse and manage configuration`);
  console.log('');
  console.log('  Usage: overwatch config <subcommand> [options]');
  console.log('');
  console.log('  Subcommands:');
  console.log(`    view ${DIM}[section] [--raw] [--json]${NC}  Show resolved configuration`);
  console.log(`    edit ${DIM}[section]${NC}                   Edit configuration interactively`);
  console.log(`    docs ${DIM}[section]${NC}                   Show available config options`);
  console.log(`    validate ${DIM}[--diff]${NC}                Validate config and environment`);
  console.log('');
  console.log('  Examples:');
  console.log(`    ${DIM}overwatch config${NC}                  Interactive menu`);
  console.log(`    ${DIM}overwatch config view database${NC}    Show database section`);
  console.log(`    ${DIM}overwatch config view --json${NC}      Output as JSON`);
  console.log(`    ${DIM}overwatch config docs services${NC}    Show service config options`);
  console.log(`    ${DIM}overwatch config validate --diff${NC}  Show diff against defaults`);
  console.log('');
}

async function showMenu(): Promise<void> {
  console.log('');
  console.log(`${BOLD}${CYAN}Overwatch Configuration${NC}`);
  console.log('');

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { name: 'View configuration', value: 'view' },
      { name: 'Edit configuration', value: 'edit' },
      { name: 'Show config documentation', value: 'docs' },
      { name: 'Validate configuration', value: 'validate' },
    ],
  }]);

  switch (action) {
    case 'view':
      return runConfigView([]);
    case 'edit':
      return runConfigEdit([]);
    case 'docs':
      return runConfigDocs([]);
    case 'validate':
      return runConfigValidate([]);
  }
}
