/**
 * fetch for registry/API calls: redirects are never followed (a validated host
 * could otherwise bounce the request, credentials included, to an internal
 * address) and a 3xx is a failure.
 */
export async function fetchNoRedirect(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Registry request was redirected (HTTP ${response.status}); redirects are not followed`);
  }
  return response;
}
