// Local preview server — zero dependencies (Node 18+).
//   node scripts/dev-server.mjs            → real emails via Resend (reads .env)
//   node scripts/dev-server.mjs --dry-run  → no email sent; saved to .outbox/*.html
// Dry-run exists ONLY here. Deployed functions always send through Resend.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleReservation } from '../lib/reservation.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT) || 8787;
const dryRun = process.argv.includes('--dry-run');
const failMode = process.argv.includes('--fail-email');

// Minimal .env loader (KEY=value lines).
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

async function dryRunSend(message) {
  if (failMode) throw new Error('Simulated provider failure (--fail-email)');
  const dir = join(root, '.outbox');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${message.to.replace(/[^a-z0-9@.]/gi, '_')}.html`);
  await writeFile(file, `<!-- to: ${message.to}\n subject: ${message.subject}\n reply-to: ${message.replyTo || '-'} -->\n${message.html}`);
  console.log(`[dry-run] email to ${message.to}: "${message.subject}" → ${file}`);
  return { id: 'dry-run' };
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/reservations') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const env = (dryRun || failMode) ? { ...process.env, BOOKING_TO_EMAIL: process.env.BOOKING_TO_EMAIL || 'manhquan281003@gmail.com', BOOKING_FROM_EMAIL: process.env.BOOKING_FROM_EMAIL || 'LACA 24 <dry-run@localhost>' } : process.env;
    const result = await handleReservation({
      method: req.method,
      headers: { get: name => req.headers[name.toLowerCase()] || null },
      bodyText: Buffer.concat(chunks).toString('utf8'),
      ip: req.socket.remoteAddress
    }, env, (dryRun || failMode) ? { send: dryRunSend } : {});
    res.writeHead(result.status, result.headers).end(result.body);
    return;
  }
  const path = normalize(join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }).end(await readFile(path));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}).listen(port, () => console.log(`LACA 24 preview: http://localhost:${port}${dryRun ? '  (dry-run: emails saved to .outbox/)' : ''}${failMode ? '  (simulating email failure)' : ''}`));
