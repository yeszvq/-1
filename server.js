const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcast({ type: 'users', count: clients.size });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') {
        broadcast({ type: 'ping', name: msg.name || 'аноним' });
      }
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ type: 'users', count: clients.size });
  });
});

function broadcast(data) {
  const str = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) client.send(str);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('running on port', PORT));
