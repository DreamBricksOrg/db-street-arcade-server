// demo-snake/server.js
import http from 'http';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = 9000;
const UDP_PORT = 9001;

// 1. Array de clientes conectados via SSE (Server-Sent Events)
let sseClients = [];

// 2. Criação do Servidor HTTP
const server = http.createServer((req, res) => {
  // CORS Headers para SSE
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Enpoint SSE para o Browser
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    
    res.write('data: {"type": "connected"}\n\n');
    sseClients.push(res);

    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // Roteamento Estático Simples
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const extname = path.extname(filePath);
  
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css'
  };
  const contentType = contentTypes[extname] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('File not found');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Servidor Web rodando em http://localhost:${HTTP_PORT}`);
});

// 3. Criação do Servidor UDP
const udpServer = dgram.createSocket('udp4');

udpServer.on('error', (err) => {
  console.error(`[UDP] Erro do servidor:\n${err.stack}`);
  udpServer.close();
});

udpServer.on('message', (msg, rinfo) => {
  try {
    const payload = msg.toString('utf8');
    // Faz o broadcast para todos os browsers abertos via SSE
    sseClients.forEach(client => {
      client.write(`data: ${payload}\n\n`);
    });
  } catch(e) {
    console.error('[UDP] Erro ao repassar pacote:', e);
  }
});

udpServer.on('listening', () => {
  const address = udpServer.address();
  console.log(`[UDP] Escutando comandos do Street Arcade na porta ${address.port}`);
});

udpServer.bind(UDP_PORT);
