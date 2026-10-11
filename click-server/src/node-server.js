// Local dev adapter only (no tunnels). Binds 127.0.0.1. Generates an ephemeral signing key per run.
import http from 'node:http';
import { makeConfig } from './config.js';
import { MemoryStore } from './memory-store.js';
import { ClickEngine } from './engine.js';
import { generateKeyPair, exportPublicJwk } from './token.js';
import { makeHandler } from './worker.js';

const cfg = makeConfig({}, process.env);
const kp = await generateKeyPair(); const kid = 'dev-' + Date.now();
const engine = new ClickEngine({ store: new MemoryStore(), cfg, signingKey: kp.privateKey, kid, verifyKeys: { [kid]: kp.publicKey },
  keySecret: crypto.getRandomValues(new Uint8Array(32)).join(','), shortBase: process.env.CS_SHORT_BASE ?? 'http://127.0.0.1:8788' });
const handler = makeHandler(engine, { enqueue: ev => engine.scoreClick(ev), jwks: [await exportPublicJwk(kp.publicKey, kid)] });
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }),
    { clientIp: req.socket.remoteAddress?.replace(/^::ffff:/, '') });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(Number(process.env.PORT ?? 8788), '127.0.0.1');
export { engine };
