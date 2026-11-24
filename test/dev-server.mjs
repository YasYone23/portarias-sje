// Servidor local para testar (usa memória no lugar do Netlify Blobs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.PORTARIAS_MEMORY = '1';
const { default: api } = await import('../netlify/functions/api.mjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of rq) chunks.push(c);
    const body = Buffer.concat(chunks);
    const res = await api(new Request(url, { method: rq.method, headers: rq.headers, body: ['GET', 'HEAD'].includes(rq.method) ? undefined : body }));
    rs.writeHead(res.status, Object.fromEntries(res.headers)); rs.end(Buffer.from(await res.arrayBuffer())); return;
  }
  const f = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f)) { rs.writeHead(404); rs.end('404'); return; }
  rs.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); rs.end(fs.readFileSync(f));
}).listen(8787, () => console.log('http://localhost:8787'));
