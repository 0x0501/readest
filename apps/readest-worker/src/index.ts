const ORIGIN_HOST = 'read.sumku.cc';

const HOP_BY_HOP = [
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
];

export default {
  async fetch(request, env): Promise<Response> {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    let allowed = false;
    try {
      allowed = (await env.RATE_LIMITER.limit({ key: ip })).success;
    } catch {
      return new Response('Rate limiter unavailable', {
        status: 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (!allowed) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '60', 'cache-control': 'no-store' },
      });
    }

    const incoming = new URL(request.url);
    const target = new URL(`${incoming.pathname}${incoming.search}`, `http://${ORIGIN_HOST}`);
    const headers = new Headers(request.headers);
    headers.delete('host');
    if (!headers.has('upgrade')) {
      headers.delete('connection');
    }
    for (const name of HOP_BY_HOP) {
      headers.delete(name);
    }
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', ORIGIN_HOST);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    try {
      const response = await env.VPC_SERVICE.fetch(
        new Request(target, {
          method: request.method,
          headers,
          body: hasBody ? request.body : undefined,
          redirect: 'manual',
        }),
      );
      return withPublicLocation(response);
    } catch {
      return new Response('Origin unavailable', {
        status: 502,
        headers: { 'cache-control': 'no-store' },
      });
    }
  },
} satisfies ExportedHandler<Env>;

function withPublicLocation(response: Response): Response {
  const location = response.headers.get('location');
  if (!location) return response;
  const rewritten = rewriteLocation(location);
  if (rewritten === location) return response;
  const headers = new Headers(response.headers);
  headers.set('location', rewritten);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// The VPC service chooses the private address. A redirect must not send the
// browser, or a later request, to that address.
function rewriteLocation(value: string): string {
  let url: URL;
  try {
    url = new URL(value, `https://${ORIGIN_HOST}`);
  } catch {
    return value;
  }
  if (url.hostname === ORIGIN_HOST) {
    url.protocol = 'https:';
    url.port = '';
    return url.toString();
  }
  if (!isInternalHost(url.hostname)) return value;
  return `https://${ORIGIN_HOST}${url.pathname}${url.search}${url.hash}`;
}

function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host.includes(':')) {
    return (
      host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
    );
  }
  const parts = host.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
