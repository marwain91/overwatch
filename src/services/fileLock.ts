const locks = new Map<string, Promise<void>>();

export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (locks.has(key)) {
    await locks.get(key);
  }

  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  locks.set(key, promise);

  try {
    return await fn();
  } finally {
    locks.delete(key);
    resolve();
  }
}
