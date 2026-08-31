function response(status, body, contentType, filename, method) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  return new Response(method === 'HEAD' ? null : body, { status, headers });
}

export function createArtifactWorker({ relaySource, setupSource }) {
  return {
    async fetch(request) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        const refused = response(
          405,
          'method not allowed\n',
          'text/plain; charset=utf-8',
          null,
          request.method,
        );
        refused.headers.set('Allow', 'GET, HEAD');
        return refused;
      }

      const pathname = new URL(request.url).pathname;
      if (pathname === '/' || pathname === '/compos-relay.mjs') {
        return response(
          200,
          relaySource,
          'text/javascript; charset=utf-8',
          'compos-relay.mjs',
          request.method,
        );
      }
      if (pathname === '/setup-local-tls.sh') {
        return response(
          200,
          setupSource,
          'text/x-shellscript; charset=utf-8',
          'setup-local-tls.sh',
          request.method,
        );
      }
      return response(404, 'not found\n', 'text/plain; charset=utf-8', null, request.method);
    },
  };
}
