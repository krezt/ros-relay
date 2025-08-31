const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();

// Basic HTTP routes for sanity/health
app.get("/", (_req, res) => res.send("ROS relay OK"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// We upgrade HTTP → WS on /ws (Render supports upgrades on web services)
const wss = new WebSocket.Server({ noServer: true });

// roomName -> Set<ws>
const rooms = new Map();
function roomSet(name) {
  let s = rooms.get(name);
  if (!s) {
    s = new Set();
    rooms.set(name, s);
  }
  return s;
}

function joinRoom(ws, name) {
  // leave previous room, if any
  if (ws._room) {
    const prev = rooms.get(ws._room);
    if (prev) {
      prev.delete(ws);
      if (prev.size === 0) rooms.delete(ws._room);
    }
  }

  ws._room = name;
  roomSet(name).add(ws);

  // tell the client we’re ready (the client code looks for hello_ack)
  send(ws, { kind: "hello_ack", id: ws._id, room: name });
  console.log(`[join] ws#${ws._id} → room="${name}"`);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function listRooms() {
  const out = [];
  for (const [id, set] of rooms) {
    if (id !== "lobby") out.push({ id, players: set.size, name: id });
  }
  return out;
}

// Handle the HTTP → WS upgrade only on /ws
server.on("upgrade", (req, socket, head) => {
  try {
    if (!req.url.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    try { socket.destroy(); } catch {}
  }
});

let nextId = 1;

wss.on("connection", (ws, req) => {
  ws._id = nextId++;
  ws._name = `Player-${ws._id}`;

  // Parse ?room=… (default to lobby)
  const params = new URL(req.url, "http://localhost").searchParams;
  const room = params.get("room") || "lobby";
  joinRoom(ws, room);

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { console.warn(`[bad JSON] ws#${ws._id}:`, e); return; }

    // Minimal lobby/matchmaking API expected by your client
    switch (msg.kind) {
      case "set_name": {
        if (typeof msg.name === "string") ws._name = msg.name.slice(0, 32);
        break;
      }

      case "list_rooms": {
        // IMPORTANT: client expects "rooms", not "list"
        const roomsArr = listRooms();
        send(ws, { kind: "rooms", rooms: roomsArr });
        // small log so you can see responses happen
        console.log(`[rooms] → ws#${ws._id} (${roomsArr.length} rooms)`);
        break;
      }

      case "create_room": {
        const id = (msg.id || Math.random().toString(36).slice(2, 8)).toLowerCase();
        joinRoom(ws, id);
        send(ws, { kind: "room_created", id });
        break;
      }

      case "join_room": {
        if (msg.id) {
          joinRoom(ws, String(msg.id));
          send(ws, { kind: "room_joined", id: String(msg.id) });
        }
        break;
      }

      // Anything else: relay to peers in the same room
      default: {
        const peers = rooms.get(ws._room) || new Set();
        for (const peer of peers) {
          if (peer !== ws && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify(msg));
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const set = rooms.get(ws._room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(ws._room);
    }
    console.log(`[close] ws#${ws._id}`);
  });
});

// Keep-alive pings so Render/clients don’t silently drop the socket
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.ping(); } catch {}
    }
  }
}, 25000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("relay listening on", PORT));
