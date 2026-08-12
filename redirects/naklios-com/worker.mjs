const CANONICAL_ORIGIN = 'https://naklios.dev';

export function redirectRequest(request) {
  const incoming = new URL(request.url);
  const location = `${CANONICAL_ORIGIN}${incoming.pathname}${incoming.search}`;
  return new Response(null, {
    status: 308,
    headers: {
      'cache-control': 'public, max-age=3600',
      location,
    },
  });
}

export default {
  fetch: redirectRequest,
};
