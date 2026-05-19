export type TrustProxySetting = boolean | number | string;

// Default: trust exactly one upstream hop. Matches the intended deployment
// (Traefik in front of Overwatch on the same Docker network). Trusting
// `linklocal`/`uniquelocal` would allow any container on a shared bridge
// network to spoof X-Forwarded-For — operators on multi-tenant networks
// should set OVERWATCH_TRUST_PROXY to their specific proxy subnet/IP.
const DEFAULT_TRUST_PROXY = 1;

export function resolveTrustProxySetting(env: { OVERWATCH_TRUST_PROXY?: string } = process.env): TrustProxySetting {
  const raw = env.OVERWATCH_TRUST_PROXY?.trim();
  if (!raw) return DEFAULT_TRUST_PROXY;

  const lower = raw.toLowerCase();
  if (['0', 'false', 'off', 'no', 'none'].includes(lower)) {
    return false;
  }
  if (lower === '1') {
    return 1;
  }
  if (['true', 'on', 'yes'].includes(lower)) {
    return true;
  }

  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }

  return raw;
}
