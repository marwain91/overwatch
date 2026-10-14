// `compose up -d` waits for `service_completed_successfully` migrators and the
// first `up` pulls images, so a legitimate run can take far longer than a quick
// command. Killing it mid-migration would leave a half-migrated database, so the
// bound only exists to stop a hung daemon pinning the tenant lock forever.
export const COMPOSE_LONG_TIMEOUT_MS = 3_600_000;
