import * as fs from 'fs/promises';
import * as path from 'path';
import { withFileLock } from '../services/fileLock';
import { writeFileAtomic } from './atomicJson';

/**
 * Append-only line log (audit log, alert history) with one serialized writer.
 *
 * Appends are queued and flushed in insertion order by a background drain;
 * prune runs on the same chain, so an append that arrives while a prune is
 * rewriting the file waits and lands in the new file instead of being lost to
 * the rename. Each file operation also takes a lockfile so a CLI process
 * appending to the same file cannot interleave with a prune.
 */
// Bound on queued lines while the file is unwritable, so a long outage cannot grow memory without limit.
const MAX_QUEUED_LINES = 10_000;

// An unwritable file is retried this many times with exponential backoff
// (1s, 2s, 4s, 8s), then left alone until the cooldown passes or someone
// flushes. Without the bound, one drain would hold the chain forever.
const MAX_DRAIN_ATTEMPTS = 5;
const RETRY_COOLDOWN_MS = 60_000;

const RENAME_BLOCKED = new Set(['EBUSY', 'EXDEV', 'EPERM']);

/** Truncate + write through the existing inode, keeping its mode. Not crash-atomic, but the lock is held. */
async function rewriteInPlace(file: string, content: string): Promise<void> {
  const handle = await fs.open(file, 'r+');
  try {
    await handle.truncate(0);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonlLog {
  private queue: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private errorLogged = false;
  private inPlaceLogged = false;
  private retryNotBefore = 0;

  constructor(private readonly getFile: () => string, private readonly tag: string) {}

  /** Queue one pre-serialised line (no trailing newline). Never throws. */
  append(line: string): void {
    this.queue.push(line + '\n');
    this.run(() => this.drain());
  }

  /** Resolves once everything queued so far has been written. */
  async flush(): Promise<void> {
    // Forced: a single attempt even inside the cooldown, so shutdown stays bounded.
    await this.run(() => this.drain(true));
  }

  /** Keep the newest `maxEntries` lines; returns how many were dropped. */
  async prune(maxEntries: number): Promise<number> {
    return this.run(() => this.lockedPrune(maxEntries));
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }

  private lockKey(): string {
    return `jsonl-${path.basename(this.getFile())}`;
  }

  private async drain(force = false): Promise<void> {
    if (!force && Date.now() < this.retryNotBefore) return;
    let attempts = 0;
    while (this.queue.length > 0) {
      // Take everything queued so many entries share one append.
      const lines = this.queue.splice(0, this.queue.length);
      try {
        const file = this.getFile();
        await withFileLock(this.lockKey(), async () => {
          // Mode 0600 on create (umask may loosen it); chmod each time so a
          // historically 0644 file is tightened on the next entry.
          await fs.appendFile(file, lines.join(''), { mode: 0o600 });
          await fs.chmod(file, 0o600).catch(() => {});
        });
        this.errorLogged = false;
        this.retryNotBefore = 0;
        attempts = 0;
      } catch (err: any) {
        // Keep the lines (one entry each, so the cap counts lines) and log once per outage.
        this.queue.unshift(...lines);
        const dropped = this.queue.length - MAX_QUEUED_LINES;
        if (dropped > 0) {
          this.queue.splice(0, dropped);
          console.error(`[${this.tag}] dropped ${dropped} oldest queued line(s) during a write outage`);
        }
        if (!this.errorLogged) {
          console.error(`[${this.tag}] write failed: ${err?.message || err}. Retrying with backoff; up to ${MAX_QUEUED_LINES} lines are kept in memory meanwhile.`);
          this.errorLogged = true;
        }
        attempts++;
        if (force || attempts >= MAX_DRAIN_ATTEMPTS) {
          this.retryNotBefore = Date.now() + RETRY_COOLDOWN_MS;
          return;
        }
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempts - 1), 8000)));
      }
    }
  }

  private async lockedPrune(maxEntries: number): Promise<number> {
    // Flush first so queued entries are part of what is counted and kept.
    await this.drain();
    const file = this.getFile();
    return withFileLock(this.lockKey(), async () => {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') return 0;
        throw err;
      }
      const lines = content.split('\n').filter(Boolean);
      if (lines.length <= maxEntries) return 0;
      const kept = lines.slice(-maxEntries).join('\n') + '\n';
      try {
        await writeFileAtomic(file, kept, { mode: 0o600 });
      } catch (err: any) {
        // A file bind-mounted on its own cannot be replaced by rename.
        if (!RENAME_BLOCKED.has(err?.code)) throw err;
        if (!this.inPlaceLogged) {
          console.warn(`[${this.tag}] ${file} cannot be replaced by rename (${err.code}); pruning by rewriting it in place`);
          this.inPlaceLogged = true;
        }
        await rewriteInPlace(file, kept);
      }
      return lines.length - maxEntries;
    });
  }
}

const logs = new Map<string, JsonlLog>();

/** One writer per file path, so every caller shares the same queue. */
export function jsonlLogFor(file: string, tag: string = 'jsonl'): JsonlLog {
  let log = logs.get(file);
  if (!log) {
    log = new JsonlLog(() => file, tag);
    logs.set(file, log);
  }
  return log;
}
