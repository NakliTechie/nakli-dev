import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

const pairCode = 'test-pair-code-1234567890';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, { path = '/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForBridge(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`bridge start timed out: ${output}`)), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/nakli-compos-relay listening: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited ${code}: ${output}`));
    });
  });
}

function upgrade(port, cookie) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`upgrade timed out: ${data}`));
    }, 3000);
    socket.on('connect', () => {
      socket.write([
        'GET /live/websocket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGVzdC1icmlkZ2Uta2V5',
        'Sec-WebSocket-Version: 13',
        'Origin: http://localhost:8000',
        cookie ? `Cookie: ${cookie}` : '',
        '',
        '',
      ].filter((line) => line !== '').join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', reject);
  });
}

test('the Compos bridge pairs HTTP and WebSocket traffic', async (t) => {
  let upgradeOrigin = null;
  const upgradedSockets = new Set();
  const upstream = http.createServer((req, res) => {
    const body = JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  upstream.on('upgrade', (req, socket) => {
    upgradeOrigin = req.headers.origin;
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const upstreamPort = await listen(upstream);

  const child = spawn(process.execPath, [
    new URL('./compos-relay.mjs', import.meta.url).pathname,
    '--target', `http://127.0.0.1:${upstreamPort}`,
    '--port', '0',
  ], {
    env: {
      ...process.env,
      DISABLE_TLS: '1',
      NAKLI_BRIDGE_PAIR_TOKEN: pairCode,
      SESSION_TTL_SECONDS: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridgePort = await waitForBridge(child);

  t.after(async () => {
    child.kill('SIGTERM');
    for (const socket of upgradedSockets) socket.destroy();
    await close(upstream);
  });

  const refused = await request(bridgePort);
  assert.equal(refused.status, 401);

  const badPair = await request(bridgePort, { path: '/?pair=wrong-code' });
  assert.equal(badPair.status, 401);

  const preflight = await request(bridgePort, {
    method: 'OPTIONS',
    headers: { Origin: 'https://naklios.dev', 'Access-Control-Request-Private-Network': 'true' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

  const refusedPreflight = await request(bridgePort, {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(refusedPreflight.status, 403);

  const paired = await request(bridgePort, { path: `/?pair=${pairCode}` });
  assert.equal(paired.status, 303);
  assert.equal(paired.headers.location, '/');
  const cookie = paired.headers['set-cookie'][0].split(';', 1)[0];
  assert.match(paired.headers['set-cookie'][0], /HttpOnly/);
  assert.match(paired.headers['set-cookie'][0], /SameSite=Strict/);

  const replayedPair = await request(bridgePort, { path: `/?pair=${pairCode}` });
  assert.equal(replayedPair.status, 401);

  const refusedOrigin = await request(bridgePort, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://attacker.example' },
  });
  assert.equal(refusedOrigin.status, 403);

  const proxied = await request(bridgePort, { path: '/compos?mode=test', headers: { Cookie: cookie } });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers['access-control-allow-private-network'], 'true');
  assert.match(proxied.headers['content-security-policy'], /frame-ancestors/);
  assert.deepEqual(JSON.parse(proxied.body), {
    url: '/compos?mode=test',
    host: `127.0.0.1:${upstreamPort}`,
    origin: `http://127.0.0.1:${upstreamPort}`,
  });

  const refusedUpgrade = await upgrade(bridgePort, '');
  assert.match(refusedUpgrade, /^HTTP\/1\.1 401/);

  const acceptedUpgrade = await upgrade(bridgePort, cookie);
  assert.match(acceptedUpgrade, /^HTTP\/1\.1 101/);
  assert.equal(upgradeOrigin, `http://127.0.0.1:${upstreamPort}`);
});
