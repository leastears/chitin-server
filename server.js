const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 2567;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", game: "Chitin" });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const clients = new Map();
const playerStates = new Map();

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function randPos() {
  return (Math.random() - 0.5) * 1600;
}

wss.on("connection", (ws) => {
  const sessionId = genId();
  const client = { ws, sessionId, lastPing: Date.now() };
  clients.set(sessionId, client);

  const playerState = {
    x: randPos(),
    y: randPos(),
    rot_head: 0,
    jaw_open: 0,
    hp: 100,
    is_alive: true,
    is_moving: false,
    name: `Worm_${sessionId.slice(0, 4)}`,
  };
  playerStates.set(sessionId, playerState);

  console.log(`[+] ${sessionId} connected (${clients.size} online)`);

  // Welcome
  ws.send(JSON.stringify({ type: "welcome", session_id: sessionId }));

  // Full state
  const players = {};
  for (const [id, state] of playerStates) {
    players[id] = state;
  }
  ws.send(JSON.stringify({ type: "full_state", players }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const state = playerStates.get(sessionId);
      if (!state) return;

      client.lastPing = Date.now();

      if (msg.type === "ping") {
        const ts = msg.timestamp || (msg.data ? msg.data.timestamp : null);
        ws.send(JSON.stringify({ type: "pong", timestamp: ts }));
        return;
      } else if (msg.type === "join") {
        return;
      } else if (msg.type === "input") {
        const input = msg.data || msg;
        state.name = input.name || state.name;
        state.rot_head = input.target_angle ?? input.rot_head ?? state.rot_head;
        state.is_moving = input.is_moving ?? false;
        state.jaw_open = input.jaw_open ?? 0;
        if (typeof input.x === "number" && typeof input.y === "number") {
          state.x = input.x;
          state.y = input.y;
        }
      } else if (msg.type === "bite") {
        const targetId = msg.target_id;
        const charge = Math.min(Math.max(msg.charge ?? 0.5, 0), 1);
        const targetState = playerStates.get(targetId);

        if (targetState && targetState.is_alive && state.is_alive) {
          const dx = state.x - targetState.x;
          const dy = state.y - targetState.y;
          const distSq = dx * dx + dy * dy;

          if (distSq <= 80 * 80 * 4) {
            const damage = 20 * charge;
            targetState.hp = Math.max(0, targetState.hp - damage);
            console.log(`${sessionId} bit ${targetId} for ${damage.toFixed(1)} dmg`);

            if (targetState.hp <= 0) {
              targetState.is_alive = false;
              broadcastAll({
                type: "player_died",
                player_id: targetId,
                killer_id: sessionId,
              });

              setTimeout(() => {
                if (playerStates.has(targetId)) {
                  const p = playerStates.get(targetId);
                  p.hp = 100;
                  p.is_alive = true;
                  p.x = randPos();
                  p.y = randPos();
                }
              }, 5000);
            }
          }
        }
      } else if (msg.type === "chat") {
        broadcastAll({
          type: "chat",
          name: state.name,
          text: String(msg.text || "").slice(0, 100),
        });
      }
    } catch (e) {
      console.error("[ERROR]", e);
    }
  });

  ws.on("close", () => {
    clients.delete(sessionId);
    playerStates.delete(sessionId);
    console.log(`[-] ${sessionId} disconnected (${clients.size} online)`);
    broadcastAll({ type: "player_left", player_id: sessionId });
  });

  ws.on("error", (err) => console.error(`[WS] ${sessionId}:`, err));
});

function broadcastAll(msg) {
  const payload = JSON.stringify(msg);
  for (const [, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}

// Broadcast state 20x per second
setInterval(() => {
  const players = {};
  for (const [id, state] of playerStates) {
    players[id] = state;
  }

  const payload = JSON.stringify({
    type: "world_sync",
    players,
  });

  for (const [, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}, 50);

// v20260428-0336 Restart Trigger
httpServer.listen(PORT, () => {
  console.log(`\n🐛 Chitin ws://localhost:${PORT} (READY)\n`);
});
