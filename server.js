// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.get('/', (_req, res) => res.send('ROS relay OK'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// --- Rooms and queue ---
/** Map<string, Set<WebSocket>> */
const rooms = new Map();
/** waiting player for quick-match (null or WebSocket) */
let waiting = null;

function randId(len = 6) {
  return crypto.randomBytes(8).toString('base64url').slice(0, len);
}
function roleLabel(ws) {
  // map A/B to host/guest (what client understands)
  return ws._role === 'A' ? 'host' : (ws._role === 'B' ? 'guest' : null);
}
function roomSet(id) {
  let set = rooms.get(id);
  if (!set) { set = new Set(); rooms.set(id, set); }
  return set;
}
function leaveCurrentRoom(ws) {
  if (!ws._room) return;
  const set = rooms.get(ws._room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(ws._room);
  }
  ws._room = null;
  ws._role = null;
}
function joinRoom(ws, id) {
  leaveCurrentRoom(ws);
  ws._room = id;
  roomSet(id).add(ws);
  send(ws, { kind: 'hello_ack', id: ws._id, room: id });
  // let everyone see the fresh room list
  broadcastLobbyRooms();
}
function listRooms() {
  const out = [];
  for (const [id, set] of rooms) {
    if (id === 'lobby') continue;
    out.push({
      id,
      name: id,              // simple label; client will show this
      players: set.size
    });
  }
  return out;
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
function broadcast(roomId, obj, except) {
  const set = rooms.get(roomId);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const peer of set) {
    if (peer !== except && peer.readyState === WebSocket.OPEN) {
      peer.send(data);
    }
  }
}
function broadcastLobbyRooms() {
  const payload = { kind: 'rooms', rooms: listRooms() };
  // broadcast into lobby (and to anyone else who cares)
  for (const [, set] of rooms) {
    for (const ws of set) send(ws, payload);
  }
}

function startMatchInRoom(roomId) {
  const set = rooms.get(roomId);
  if (!set || set.size < 2) return;
  // pick two sockets deterministically
  const players = Array.from(set).slice(0, 2);
  const A = players[0], B = players[1];
  A._role = 'A';
  B._role = 'B';
  // Notify each side who they are
  send(A, { kind: 'match', roomId, you: 'A' });
  send(B, { kind: 'match', roomId, you: 'B' });

  // let both clients know each other's names (if set already)
  if (A._name) broadcast(roomId, { kind: 'name', who: roleLabel(A), name: A._name });
  if (B._name) broadcast(roomId, { kind: 'name', who: roleLabel(B), name: B._name });
}

// --- HTTP→WS upgrade only at /ws ---
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// --- Connection handler ---
wss.on('connection', (ws, req) => {
  ws._id = Math.floor(Math.random() * 1e9);
  ws._name = null;
  ws._room = null;
  ws._role = null;
  ws.isAlive = true;

  // parse ?room=
  const params = new URL(req.url, 'http://x').searchParams;
  const room = params.get('room') || 'lobby';
  joinRoom(ws, room);

  // heartbeat
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // --- lobby API the client expects ---
    if (msg.kind === 'set_name' && typeof msg.name === 'string') {
      ws._name = String(msg.name).slice(0, 32);
      // tell peers my name (uses who: host/guest)
      if (ws._room) {
        broadcast(ws._room, { kind: 'name', who: roleLabel(ws), name: ws._name });
      }
      return;
    }

    if (msg.kind === 'list_rooms') {
      send(ws, { kind: 'rooms', rooms: listRooms() });
      return;
    }

    if (msg.kind === 'create_room') {
      const id = msg.id || randId();
      joinRoom(ws, id);
      send(ws, { kind: 'room_created', id });
      // If someone else joins, we'll start the match then.
      return;
    }

    if (msg.kind === 'join_room' && msg.id) {
      joinRoom(ws, String(msg.id));
      send(ws, { kind: 'room_joined', id: String(msg.id) });
      // auto-start when 2 players present
      const set = rooms.get(ws._room);
      if (set && set.size === 2) startMatchInRoom(ws._room);
      return;
    }

    if (msg.kind === 'queue') {
      // Quick Match flow
      send(ws, { kind: 'queued' }); // show "searching" on client
      if (!waiting || waiting.readyState !== WebSocket.OPEN) {
        waiting = ws;
        return;
      }
      // pair waiting + ws into a fresh room
      const id = randId();
      joinRoom(waiting, id);
      joinRoom(ws, id);
      startMatchInRoom(id);
      waiting = null;
      return;
    }

    // --- gameplay messages: just relay to peers in the same room ---
    if (ws._room) {
      broadcast(ws._room, msg, ws);
    }
  });

  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    const roomId = ws._room;
    leaveCurrentRoom(ws);
    if (roomId) {
      // tell remaining peer (if any)
      broadcast(roomId, { kind: 'opponent_disconnected' });
      broadcastLobbyRooms();
    }
  });
});

// heartbeat (keeps Render from closing idle sockets)
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
wss.on('close', () => clearInterval(interval));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('relay listening on', PORT));
