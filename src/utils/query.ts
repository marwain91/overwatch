/** Safely extract a single string from a query param that may be an array */
export function queryString(val: unknown): string | undefined {
  if (Array.isArray(val)) return typeof val[0] === 'string' ? val[0] : undefined;
  return typeof val === 'string' ? val : undefined;
}

/** Parse a query param as an integer with bounds clamping */
export function queryInt(val: unknown, fallback: number, min: number, max: number): number {
  const raw = parseInt(queryString(val) || '', 10);
  return Number.isInteger(raw) ? Math.max(min, Math.min(raw, max)) : fallback;
}
