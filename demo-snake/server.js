// demo-snake/server.js
import http from 'http';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT  = 9000;
const UDP_PORT   = 9001;
const BACKEND_URL = process.env.BACKEND_URL || '';

// Static identity of this physical totem — set in .env
// This allows the server to know its totemId even before any player connects.
let currentTotemId = process.env.TOTEM_ID || null;

console.log(`[BOOT] BACKEND_URL  : ${BACKEND_URL || '(none)'}`);
console.log(`[BOOT] TOTEM_ID     : ${currentTotemId || '(will be learned via UDP)'}`);

// ── SSE Clients ─────────────────────────────────────────────────────────────
let sseClients = [];

function broadcast(payload) {
  const msg = `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => { try { client.write(msg); } catch {} });
}

// ── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // SSE endpoint — game browser subscribes here to receive UDP events
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':   'keep-alive',
    });

    // ─── HANDSHAKE: immediately send current state to the new client ───────
    res.write('data: {"type":"connected"}\n\n');
    if (currentTotemId) {
      // The game browser now immediately knows which totem it belongs to
      res.write(`data: ${JSON.stringify({ type: 'init', totemId: currentTotemId })}\n\n`);
    }

    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // State endpoint — game browser can poll this to get current totemId
  if (req.method === 'GET' && req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totemId: currentTotemId }));
    return;
  }

  // Proxy: ends the active session for this totem when a player dies
  if (req.method === 'POST' && req.url === '/end-session') {
    if (!BACKEND_URL || !currentTotemId) {
      console.warn('[HTTP] /end-session called but no totemId registered');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'no totemId registered' }));
      return;
    }

    const totemId = currentTotemId;
    console.log(`[HTTP] Ending session for totem: ${totemId}`);

    fetch(`${BACKEND_URL}/api/totems/${totemId}/end-session`, { method: 'POST' })
      .then(r => r.json())
      .then(json => {
        console.log(`[HTTP] end-session response:`, json);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      })
      .catch(err => {
        console.error('[HTTP] end-session proxy failed:', err.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      });
    return;
  }

  // Static file serving
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : `Server Error: ${err.code}`);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Listening on http://localhost:${HTTP_PORT}`);
});

// ── UDP Server ───────────────────────────────────────────────────────────────
const udpServer = dgram.createSocket('udp4');

udpServer.on('error', (err) => {
  console.error(`[UDP] Error:\n${err.stack}`);
  udpServer.close();
});

udpServer.on('message', (msg) => {
  try {
    const payload = msg.toString('utf8');
    const data = JSON.parse(payload);

    // Learn totemId from the session_start packet the backend sends on player connect
    if (data.type === 'session_start') {
      if (data.tid) {
        if (currentTotemId && currentTotemId !== data.tid) {
          console.warn(`[UDP] totemId changed: ${currentTotemId} → ${data.tid}`);
        }
        currentTotemId = data.tid;
        console.log(`[UDP] Session start — totem: ${data.tid} | session: ${data.sid}`);
      }
    }

    // Broadcast all UDP events to connected browser clients via SSE
    broadcast(payload);
  } catch (e) {
    console.error('[UDP] Parse error:', e.message);
  }
});

udpServer.on('listening', () => {
  const { port } = udpServer.address();
  console.log(`[UDP] Listening on port ${port}`);
});

udpServer.bind(UDP_PORT);
