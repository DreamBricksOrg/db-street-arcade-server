// games/brick-rush/server.js
// Bridge server for Brick Rush (same pattern as demo-snake):
//   - UDP :9101  → receives backend packets (inputs, player_join, player_leave)
//   - SSE /events → forwards every UDP packet to the browser game
//   - POST /end-session → proxies player elimination to the backend
//   - GET  /queue-state → proxies the totem queue view (rotation + HUD)
//   - HTTP :9100 → serves the static game files
// Zero dependencies — plain Node.

import http from 'http';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env manually — standalone game, no dotenv.
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  console.warn('[BOOT] No .env file found — relying on shell environment variables');
}

const HTTP_PORT   = 9100;
const UDP_PORT    = 9101;
const BACKEND_URL = process.env.BACKEND_URL || '';

// Static identity of this totem — set in .env, or learned from player_join packets.
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

  // SSE endpoint — the game browser subscribes here to receive UDP events
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':   'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    if (currentTotemId) {
      res.write(`data: ${JSON.stringify({ type: 'init', totemId: currentTotemId })}\n\n`);
    }
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Proxy: eliminates one player's session (match rotation / death rules)
  if (req.method === 'POST' && req.url === '/end-session') {
    if (!BACKEND_URL || !currentTotemId) {
      console.warn('[HTTP] /end-session called but no totemId registered');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'no totemId registered' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let playerId = null;
      try { playerId = JSON.parse(body || '{}').pid ?? null; } catch {}

      console.log(`[HTTP] Eliminating player — totem: ${currentTotemId}, player: ${playerId || '(unknown)'}`);
      fetch(`${BACKEND_URL}/api/totems/${currentTotemId}/end-session`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ playerId }),
      })
        .then(r => r.json())
        .then(json => {
          console.log('[HTTP] end-session response:', json);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        })
        .catch(err => {
          console.error('[HTTP] end-session proxy failed:', err.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        });
    });
    return;
  }

  // Game config from .env (rounds, timers) — consumed by match.js at boot
  if (req.method === 'GET' && req.url === '/config') {
    const num = (v, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rounds:      num(process.env.GAME_ROUNDS, 3),
      roundMs:     num(process.env.ROUND_TIME_S, 90) * 1000,
      graceMs:     num(process.env.GRACE_TIME_S, 10) * 1000,
      lobbyWaitMs: num(process.env.LOBBY_WAIT_S, 30) * 1000,
    }));
    return;
  }

  // Proxy: totem queue/sessions view (rotation K and HUD queue size)
  if (req.method === 'GET' && req.url === '/queue-state') {
    if (!BACKEND_URL || !currentTotemId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [], queue: [], maxPlayers: 0 }));
      return;
    }
    fetch(`${BACKEND_URL}/api/totems/${currentTotemId}/queue`)
      .then(r => r.json())
      .then(json => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: [], queue: [], maxPlayers: 0 }));
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

    // Learn totemId from player_join packets
    if (data.type === 'player_join') {
      if (data.tid) {
        if (currentTotemId && currentTotemId !== data.tid) {
          console.warn(`[UDP] totemId changed: ${currentTotemId} → ${data.tid}`);
        }
        currentTotemId = data.tid;
        console.log(`[UDP] Player join — totem: ${data.tid} | session: ${data.sid} | player: ${data.pid}`);
      }
    }

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
