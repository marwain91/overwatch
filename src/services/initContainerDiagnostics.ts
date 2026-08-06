import type { AppDefinition } from '../models/app';
import { runDocker } from '../utils/runDocker';

/** Tail of the init container log to attach to a failed deploy. */
const LOG_TAIL_LINES = 50;
/** Hard cap per container so a chatty migration can't flood the API/WS payload. */
const MAX_LOG_CHARS = 4000;

type AppShape = Pick<AppDefinition, 'id' | 'services'>;

function truncate(text: string): string {
  if (text.length <= MAX_LOG_CHARS) return text;
  return `…(truncated)\n${text.slice(-MAX_LOG_CHARS)}`;
}

/**
 * Describe any init container of `app`/`tenantId` that did not exit 0.
 *
 * Once dependents are gated on `service_completed_successfully`, a failed
 * migration makes `docker compose up` exit non-zero with "service 'migrator'
 * didn't complete successfully: exit 127" — accurate, but it doesn't say why.
 * The why is in the init container's own logs, so collect them and hand them
 * to the operator with the failure.
 *
 * Call this BEFORE any rollback: restoring the previous compose file recreates
 * containers and destroys the evidence.
 *
 * Best-effort by design — this runs on an error path, so it never throws and
 * returns '' when it has nothing to add rather than masking the real failure.
 */
export async function describeFailedInitContainers(app: AppShape, tenantId: string): Promise<string> {
  const initServices = app.services.filter(s => s.is_init_container);
  if (initServices.length === 0) return '';

  const reports: string[] = [];

  for (const service of initServices) {
    const containerName = `${app.id}-${tenantId}-${service.name}`;
    try {
      const { stdout } = await runDocker(
        'docker',
        ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', containerName],
        { timeoutMs: 15_000 },
      );
      const [status, rawExitCode] = stdout.trim().split(/\s+/);
      const exitCode = Number(rawExitCode);
      // A running init container is mid-flight, not failed; exit 0 is success.
      if (status === 'running' || exitCode === 0 || Number.isNaN(exitCode)) continue;

      let logs = '';
      try {
        const result = await runDocker(
          'docker',
          ['logs', '--tail', String(LOG_TAIL_LINES), containerName],
          { timeoutMs: 30_000 },
        );
        logs = `${result.stdout}${result.stderr}`.trim();
      } catch {
        // Logs unavailable (driver without log read support, container pruned).
      }

      const header = `init container '${service.name}' (${containerName}) exited ${exitCode}`;
      reports.push(logs ? `${header}:\n${truncate(logs)}` : `${header} (no logs available)`);
    } catch {
      // Container never created, already removed, or docker unreachable —
      // nothing to report for this service.
    }
  }

  return reports.join('\n\n');
}
