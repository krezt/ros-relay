// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();

// Minimal HTTP routes (health / sanity)
app.get('/', (_req, res) => res.send('ROS relay OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// We upgrade only the /ws path to WebSocket
const wss = new WebSocket.Server({ noServer: true });

// roomName -> Set<WebSocket>
const rooms = new Map();

function roomSet(name) {
  let s = rooms.get(name);
  if (!s) {
    s = new Set();
    rooms.set(name, s);
  }
  return s;
}

function send(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (_) {
    // ignore
  }
}

function broadcast(roomId, obj, exceptWs = null) {
  const set = rooms.get(roomId);
  if (!set) return;
  const payload = JSON.stringify(obj);
  for (const peer of set) {
    if (peer === exceptWs) continue;
    if (peer.readyState === WebSocket.OPEN) {
      peer.send(payload);
    }
  }
}

function listRooms() {
  const out = [];
  for (const [id, set] of rooms) {
    if (id !== 'lobby') out.push({ id, count: set.size });
  }
  return out;
}

function joinRoom(ws, name) {
  // leave current room if any
  if (ws._room && rooms.get(ws._room)) {
    const old = rooms.get(ws._room);
    old.delete(ws);
    if (old.size === 0) rooms.delete(ws._room);
    // notify remaining peer that someone left
    broadcast(ws._room, { kind: 'opponent_disconnected' });
  }

  ws._room = name;
  roomSet(name).add(ws);

  // greet
  send(ws, { kind: 'hello', room: name });
}

function maybeStartMatch(roomId) {
  const set = rooms.get(roomId);
  if (!set || set.size !== 2) return;
  const [a, b] = [...set];

  // Simple IDs for peers
  a._id = a._id || Math.random().toString(36).slice(2);
  b._id = b._id || Math.random().toString(36).slice(2);

  // Tell each side who they are (client maps A→host, B→guest)
  send(a, { kind: 'match', roomId, you: 'A' });
  send(b, { kind: 'match', roomId, you: 'B' });
}

server.on('upgrade', (req, socket, head) => {
  try {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch {
    try { socket.destroy(); } catch (_) {}
  }
});

wss.on('connection', (ws, req) => {
  // Parse ?room=... from the request URL
  let roomName = 'lobby';
  try {
    const url = new URL(req.url, 'http://localhost');
    roomName = url.searchParams.get('room') || 'lobby';
  } catch (_) {
    // keep default lobby
  }

  // Put this socket into the room
  joinRoom(ws, roomName);

  // Keep-alive ping (helps some hosts/proxies)
  ws._pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);

  ws.on('pong', () => { /* no-op; presence */ });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // Acknowledge client hello (optional but your client can use it)
    if (msg.kind === 'hello') {
      ws._id = ws._id || Math.random().toString(36).slice(2);
      send(ws, { kind: 'hello_ack', id: ws._id });
      return;
    }

    // Set display name and notify peer
    if (msg.kind === 'set_name' && typeof msg.name === 'string') {
      ws._name = msg.name;
      // Let the other client know
      broadcast(ws._room, { kind: 'name', name: msg.name }, ws);
      return;
    }

    // Room list (client expects { kind:'rooms', rooms:[{id, players}] })
    if (msg.kind === 'list_rooms') {
      const roomsArr = listRooms().map(r => ({ id: r.id, players: r.count }));
      send(ws, { kind: 'rooms', rooms: roomsArr });
      return;
    }

    // Create a room
    if (msg.kind === 'create_room') {
      const id = (msg.id && String(msg.id)) || Math.random().toString(36).slice(2, 8);
      joinRoom(ws, id);
      send(ws, { kind: 'room_created', id });
      maybeStartMatch(id);
      return;
    }

    // Join a room
    if (msg.kind === 'join_room' && msg.id) {
      const id = String(msg.id);
      joinRoom(ws, id);
      send(ws, { kind: 'room_joined', id });
      maybeStartMatch(id);
      return;
    }

    // Default: relay to others in the same room (round wires, outcome, etc.)
    const set = rooms.get(ws._room);
    if (!set) return;
    for (const peer of set) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        try { peer.send(JSON.stringify(msg)); } catch (_) {}
      }
    }
  });

  ws.on('close', () => {
    if (ws._pingInterval) {
      clearInterval(ws._pingInterval);
      ws._pingInterval = null;
    }
    const set = rooms.get(ws._room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        rooms.delete(ws._room);
      } else {
        // notify remaining peers that someone left
        broadcast(ws._room, { kind: 'opponent_disconnected' });
      }
    }
  });

  ws.on('error', () => {
    // Let close handler clean up
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('relay listening on', PORT);
});
