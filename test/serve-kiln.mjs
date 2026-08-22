import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.KILN_TEST_PORT || 8765);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) throw new Error('path traversal');
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const body = await readFile(file);
    response.statusCode = 200;
    response.setHeader('Content-Type', types.get(extname(file)) || 'application/octet-stream');
    response.end(body);
  } catch (error) {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(`Not found: ${error.message}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Kiln test server listening at http://127.0.0.1:${port}`);
});
