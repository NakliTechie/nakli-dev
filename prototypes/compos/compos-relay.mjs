// compos-relay.mjs — authenticated loopback reverse proxy for Compos.
//
// Compos already owns its browser renderer at http://127.0.0.1:4004. This
// bridge gives that renderer a browser-trusted loopback HTTPS origin and keeps
// every HTTP and WebSocket request behind a one-time pairing code.
//
//   node prototypes/compos/compos-relay.mjs
//   node prototypes/compos/compos-relay.mjs --target http://127.0.0.1:4004 --port 9130

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const target = new URL(option('--target', process.env.COMPOS_URL || 'http://127.0.0.1:4004'));
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error('Compos target must be an http loopback URL');
}

const requestedPort = Number(option('--port', process.env.PORT || 9130));
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  throw new Error('bridge port must be an integer from 0 through 65535');
}

const bindHost = process.env.BIND_HOST || '127.0.0.1';
const pairCode = process.env.NAKLI_BRIDGE_PAIR_TOKEN || crypto.randomBytes(16).toString('base64url');
let pairAvailable = true;
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 8 * 60 * 60);
if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
  throw new Error('SESSION_TTL_SECONDS must be a positive number');
}
const cookieName = 'nakli_compos_bridge';
const sessions = new Map();

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function loadTls() {
  if (process.env.DISABLE_TLS === '1') return null;
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    return {
      cert: fs.readFileSync(process.env.TLS_CERT),
      key: fs.readFileSync(process.env.TLS_KEY),
    };
  }

  const cert = firstExisting([
    path.join(DIR, 'certs', 'fullchain.pem'),
    path.join(DIR, 'certs', 'cert.pem'),
  ]);
  const key = firstExisting([
    path.join(DIR, 'certs', 'privkey.pem'),
    path.join(DIR, 'certs', 'key.pem'),
  ]);
  if (cert && key) return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  return null;
}

const tls = loadTls();
const scheme = tls ? 'https' : 'http';
const publicHost = process.env.BRIDGE_HOST || (tls ? 'local.naklios.dev' : bindHost);

function splitOrigins(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const configuredOrigins = splitOrigins(process.env.ALLOW_ORIGINS ||
  'https://naklios.dev,http://localhost:8000,http://127.0.0.1:8000');

function currentSelfOrigins(port) {
  return new Set([
    `${scheme}://${publicHost}:${port}`,
    `${scheme}://localhost:${port}`,
    `${scheme}://127.0.0.1:${port}`,
    ...configuredOrigins,
  ]);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookies(header = '') {
  const parsed = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    parsed.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return parsed;
}

function pruneSessions(now = Date.now()) {
  for (const [token, expires] of sessions) {
    if (expires <= now) sessions.delete(token);
  }
}

function sessionFor(req) {
  pruneSessions();
  const token = cookies(req.headers.cookie).get(cookieName);
  const expires = token && sessions.get(token);
  if (!expires || expires <= Date.now()) return null;
  sessions.set(token, Date.now() + sessionTtlSeconds * 1000);
  return token;
}

function createSession() {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, Date.now() + sessionTtlSeconds * 1000);
  return token;
}

function setSessionCookie(res, token) {
  const secure = tls ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtlSeconds}${secure}`);
}

function originAllowed(origin, port) {
  if (!origin) return true;
  return currentSelfOrigins(port).has(origin);
}

function pnaHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-csrf-token',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function refuse(res, status, message) {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  headers.host = target.host;
  headers.origin = target.origin;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = scheme;
  delete headers.connection;
  delete headers.upgrade;
  return headers;
}

function responseHeaders(upstreamHeaders, port) {
  const headers = { ...upstreamHeaders };
  headers['access-control-allow-private-network'] = 'true';
  headers['referrer-policy'] = 'no-referrer';
  headers['x-content-type-options'] = 'nosniff';
  headers['content-security-policy'] =
    `frame-ancestors 'self' https://naklios.dev http://localhost:* http://127.0.0.1:*`;

  const location = headers.location;
  if (typeof location === 'string' && location.startsWith(target.origin)) {
    headers.location = `${scheme}://${publicHost}:${port}${location.slice(target.origin.length)}`;
  }
  return headers;
}

function proxyHttp(req, res, port) {
  const upstream = http.request({
    hostname: target.hostname,
    port: Number(target.port || 80),
    method: req.method,
    path: req.url,
    headers: proxyHeaders(req),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders(upstreamRes.headers, port));
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => refuse(res, 502, `Compos is unavailable: ${error.message}`));
  req.pipe(upstream);
}

function handleRequest(req, res) {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const origin = req.headers.origin || '';

  if (!originAllowed(origin, port)) return refuse(res, 403, 'origin refused');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, pnaHeaders(origin));
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `${scheme}://${req.headers.host || publicHost}`);
  const suppliedPair = url.searchParams.get('pair');
  if (req.method === 'GET' && suppliedPair !== null) {
    if (!pairAvailable || !constantTimeEqual(suppliedPair, pairCode)) {
      return refuse(res, 401, 'pairing code refused');
    }
    pairAvailable = false;
    const token = createSession();
    url.searchParams.delete('pair');
    setSessionCookie(res, token);
    res.writeHead(303, {
      Location: `${url.pathname}${url.search}${url.hash}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
    return;
  }

  if (!sessionFor(req)) return refuse(res, 401, 'pair with the Compos prototype first');

  if (req.method === 'GET' && url.pathname === '/__nakli_bridge/status') {
    const body = JSON.stringify({ service: 'nakli-compos-relay', target: target.origin });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...pnaHeaders(origin),
    });
    res.end(body);
    return;
  }

  proxyHttp(req, res, port);
}

const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);

server.on('upgrade', (req, client, head) => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const origin = req.headers.origin || '';
  if (!originAllowed(origin, port) || !sessionFor(req)) {
    client.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    client.destroy();
    return;
  }

  const upstream = net.connect(Number(target.port || 80), target.hostname);
  upstream.on('connect', () => {
    const headers = { ...req.headers, host: target.host, origin: target.origin };
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });

  const close = () => {
    if (!client.destroyed) client.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  upstream.on('error', close);
  client.on('error', close);
});

server.listen(requestedPort, bindHost, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const base = `${scheme}://${publicHost}:${port}`;
  console.log(`nakli-compos-relay listening: ${base}`);
  console.log(`Compos target: ${target.origin}`);
  console.log(`Pairing code: ${pairCode}`);
  console.log(`Pair URL: ${base}/?pair=${pairCode}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
