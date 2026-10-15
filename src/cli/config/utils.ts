// ANSI color constants + output helpers shared by every CLI command
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const RED = '\x1b[31m';
export const CYAN = '\x1b[36m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const WHITE = '\x1b[37m';
export const NC = '\x1b[0m';

export function header(title: string): void {
  const bar = '━'.repeat(Math.max(0, 48 - title.length));
  console.log('');
  console.log(`${CYAN}━━━ ${title} ${bar}${NC}`);
  console.log('');
}

export function success(msg: string): void {
  console.log(`  ${GREEN}✓${NC} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${YELLOW}!${NC} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${RED}✗${NC} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${DIM}${msg}${NC}`);
}

/** The server caches overwatch.yaml for its lifetime; CLI edits reach it only on restart. */
export function restartNotice(): void {
  warn('The running Overwatch server reads overwatch.yaml only at startup. Run `overwatch recreate` to apply this change.');
}
