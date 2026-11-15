import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, process.argv[2] ?? 'dist');
const port = Number(process.env.PORT ?? 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.map': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const within = (directory, target) => { const path = relative(directory, target); return !isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== '..'; };

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const realRoot = await realpath(root);
if (!(await stat(realRoot)).isDirectory()) throw new Error('The static server root must be a directory.');
const server = http.createServer(async (request, response) => {
  const fail = (status, message) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : `${message}\n`); };
  if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); fail(405, 'Method Not Allowed'); return; }
  let pathname;
  try { pathname = decodeURIComponent((request.url ?? '/').split('?')[0]); }
  catch { fail(400, 'Invalid URL'); return; }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((part) => part === '..' || part.startsWith('.'))) { fail(403, 'Forbidden'); return; }
  const candidate = resolve(realRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!within(realRoot, candidate)) { fail(403, 'Forbidden'); return; }
  try {
    let actual = await realpath(candidate);
    if (!within(realRoot, actual)) { fail(403, 'Forbidden'); return; }
    let info = await stat(actual);
    if (info.isDirectory()) { actual = await realpath(resolve(actual, 'index.html')); info = await stat(actual); }
    if (!within(realRoot, actual) || !info.isFile()) { fail(403, 'Forbidden'); return; }
    response.writeHead(200, { 'Content-Type': mime[extname(actual).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(actual);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch (error) { fail(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not Found' : 'Unable To Read File'); }
});
server.on('error', (error) => { console.error(`Server failed: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`FlareFront: http://127.0.0.1:${port} (${root})`));
