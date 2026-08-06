/**
 * `docker compose` writes the useful error to stderr buried in progress noise
 * ("Container x Creating", layer pulls, `time=… level=warning` banners), and
 * the fatal line is usually LAST rather than first. Taking the first non-empty
 * line — as this used to — reported "No services to build" as the reason a
 * deploy failed.
 *
 * Match the known fatal signatures first and return the signature itself, so
 * `Container product-daktela-migrator  Error service "migrator" didn't
 * complete successfully: exit 127` reduces to the part an operator needs.
 */
const FATAL_PATTERNS: RegExp[] = [
  // Init container gated by `condition: service_completed_successfully` failed.
  /service ".+?" didn't complete successfully: exit \d+/i,
  // Dependency died while a dependent was waiting on it.
  /dependency failed to start:.+/i,
  // Health-gated dependency never became healthy.
  /dependency failed to start:.+is unhealthy/i,
  /^Error response from daemon:.+/i,
  /^Error\s.+/i,
];

/** Compose progress chatter — never the reason a deploy failed. */
function isProgressNoise(line: string): boolean {
  if (/^time="[^"]*"\s+level=(warning|info|debug)/i.test(line)) return true;
  // " Container foo  Started", " Image busybox:latest  Pulled", " Network bar  Created"
  if (/^(Network|Container|Image|Volume|Service)\s+\S+\s+\w+/i.test(line)) return true;
  // Layer progress: " 025fe1949698 Extracting 1 s"
  if (/^[0-9a-f]{8,}\s/i.test(line)) return true;
  return false;
}

export function extractComposeErrorMessage(error: any): string {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const lines = stderr.split('\n').map((l: string) => l.trim()).filter(Boolean);

  for (const pattern of FATAL_PATTERNS) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match) return match[0].trim();
    }
  }

  // No known signature — fall back to the LAST meaningful line, since compose
  // prints the fatal error after all its progress output.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isProgressNoise(lines[i])) return lines[i];
  }

  return error?.message || String(error);
}
