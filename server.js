const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();

// Minimal HTTP routes (health / sanity)
app.get('/', (_req, res) => res.send('ROS relay OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// roomName -> Set<ws>
const rooms = new Map();
function roomSet(name) { let s = rooms.get(name); if (!s) { s = new Set(); rooms.set(name, s); } return s; }

function joinRoom(ws, name) {
  if (ws._room && rooms.get(ws._room)) {
    rooms.get(ws._room).delete(ws);
    if (rooms.get(ws._room).size === 0) rooms.delete(ws._room);
  }
  ws._room = name;
  roomSet(name).add(ws);
  send(ws, { kind: 'hello', room: name });
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function listRooms() {
  const out = [];
  for (const [id, set] of rooms) {
    if (id !== 'lobby') out.push({ id, count: set.size });
  }
  return out;
}

function maybeStartMatch(roomId) {
  const set = rooms.get(roomId);
  if (!set || set.size !== 2) return;
  const [a, b] = [...set];
  // Tell each side who they are (A → host, B → guest in your client)
  send(a, { kind: 'match', roomId, you: 'A' });
  send(b, { kind: 'match', roomId, you: 'B' });
}


server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  joinRoom(ws, params.get('room') || 'lobby');

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }

    // minimal lobby API your client expects
    if (msg.kind === 'set_name' && typeof msg.name === 'string') { ws._name = msg.name; return; }
    if (msg.kind === 'list_rooms') {
   const rooms = listRooms().map(r => ({ id: r.id, players: r.count }));
   send(ws, { kind: 'rooms', rooms });
   return;
    if (msg.kind === 'create_room') { const id = msg.id || Math.random().toString(36).slice(2, 8); joinRoom(ws, id); send(ws, { kind: 'room_created', id }); maybeStartMatch(id); return; }
    if (msg.kind === 'join_room' && msg.id) { joinRoom(ws, msg.id); send(ws, { kind: 'room_joined', id: msg.id }); maybeStartMatch(id); return; }
      if (msg.kind === 'set_name' && typeof msg.name === 'string') {
  ws._name = msg.name;
  for (const peer of roomSet(ws._room)) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      send(peer, { kind: 'name', name: msg.name });
    }
  }
  return;
}


    // default: relay to others in the same room
    const peers = rooms.get(ws._room) || new Set();
    for (const peer of peers) if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(msg));
  });

  ws.on('close', () => {
    const set = rooms.get(ws._room);
    if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws._room); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('relay listening on', PORT));
