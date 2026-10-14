/** Parse a .env file content into key-value pairs */
export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      env[key] = valueParts.join('=');
    }
  }

  return env;
}

/**
 * Value as compose reads it: single quotes are literal, double quotes honour
 * backslash escapes (the inverse of what `formatEnvValue` writes). Anything
 * else is returned as written.
 */
export function unquoteEnvValue(value: string): string {
  if (value.length >= 2) {
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\([\\"$])/g, '$1');
  }
  return value;
}
