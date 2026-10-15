import { inspect } from 'util';

type FatalEvent = 'uncaughtException' | 'unhandledRejection';

interface FatalDeps {
  log: (...args: unknown[]) => void;
  exit: (code: number) => void;
}

/**
 * After an uncaught error the process state is unknown (half-applied tenant
 * operations, held locks), so it logs what happened and exits non-zero; the
 * container restart policy brings it back clean.
 */
export function fatalHandler(event: FatalEvent, deps: FatalDeps = { log: console.error, exit: code => process.exit(code) }) {
  let handled = false;
  return (err: unknown): void => {
    if (handled) return;
    handled = true;
    try {
      const detail = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : inspect(err, { depth: 4 });
      deps.log(`[fatal] ${event} (pid ${process.pid}, up ${Math.round(process.uptime())}s), exiting:\n${detail}`);
    } catch {
      // stderr is gone; exit regardless.
    } finally {
      deps.exit(1);
    }
  };
}

export function installCrashHandlers(): void {
  process.on('uncaughtException', fatalHandler('uncaughtException'));
  process.on('unhandledRejection', fatalHandler('unhandledRejection'));
}
