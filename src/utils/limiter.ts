/** Run at most `max` tasks at once; later tasks wait for a free slot. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      // The finishing task hands its slot over, so `active` never dips below the cap.
      await new Promise<void>(resolve => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}
