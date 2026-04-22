const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 2567;
const MAX_CLIENTS = 16;
const BITE_RANGE_SQ = 80 * 80 * 4; // запас на лаг
const MAX_HP = 100;
const RESPAWN_MS = 5000;

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck
app.get("/", (req, res) => {
  res.json({ status: "ok", game: "Chitin", players: clients.size });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Все подключённые клиенты: Map<sessionId, { ws, state }>
const clients = new Map();

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  for (const [id, client] of clients) {
    if (client.ws !== exclude && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const [id, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}

function sendFullState(targetWs) {
  const players = {};
  for (const [id, client] of clients) {
    players[id] = client.state;
  }
  targetWs.send(JSON.stringify({ type: "full_state", players }));
}

wss.on("connection", (ws) => {
  if (clients.size >= MAX_CLIENTS) {
    ws.send(JSON.stringify({ type: "error", message: "Server full" }));
    ws.close();
    return;
  }

  const sessionId = genId();
  const state = {
    x: (Math.random() - 0.5) * 600,
    y: (Math.random() - 0.5) * 400,
    rot_head: 0,
    jaw_open: 0,
    hp: MAX_HP,
    max_hp: MAX_HP,
    is_alive: true,
    is_moving: false,
    name: "Worm_" + sessionId.slice(0, 4)
  };

  clients.set(sessionId, { ws, state });
  console.log(`[+] ${sessionId} joined. Total: ${clients.size}`);

  // Отправляем новому клиенту его ID и полный стейт
  ws.send(JSON.stringify({ type: "welcome", session_id: sessionId }));
  sendFullState(ws);

  // Сообщаем всем остальным о новом игроке
  broadcast({ type: "player_joined", player_id: sessionId, data: state }, ws);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(sessionId);
    if (!client) return;

    switch (msg.type) {
      case "chat":
        const chatText = (msg.text || "").toString().slice(0, 120).trim();
        if (!chatText) return;
        broadcastAll({
          type: "chat",
          player_id: sessionId,
          name: client.state.name,
          text: chatText
        });
        console.log(`[Chat] ${client.state.name}: ${chatText}`);
        break;

      case "input":
        // Обновляем стейт игрока
        const d = msg.data;
        Object.assign(client.state, {
          x: d.x ?? client.state.x,
          y: d.y ?? client.state.y,
          rot_head: d.rot_head ?? client.state.rot_head,
          jaw_open: d.jaw_open ?? client.state.jaw_open,
          is_moving: d.is_moving ?? client.state.is_moving,
          name: d.name || client.state.name,
        });
        // Рассылаем дельту всем остальным
        broadcast({ type: "player_update", player_id: sessionId, data: client.state }, ws);
        break;

      case "bite":
        if (!client.state.is_alive) return;
        const targetId = msg.target_id;
        const chargeRatio = Math.min(Math.max(msg.charge || 0, 0), 1);
        const target = clients.get(targetId);
        if (!target || !target.state.is_alive) return;

        // Проверка дистанции
        const dx = client.state.x - target.state.x;
        const dy = client.state.y - target.state.y;
        if (dx*dx + dy*dy > BITE_RANGE_SQ) return;

        const damage = 20 * chargeRatio;
        target.state.hp = Math.max(0, target.state.hp - damage);

        console.log(`${sessionId} bit ${targetId} for ${damage.toFixed(1)}. HP: ${target.state.hp}`);

        // Уведомляем жертву
        target.ws.send(JSON.stringify({ type: "hit", damage, attacker_id: sessionId }));

        // Смерть
        if (target.state.hp <= 0 && target.state.is_alive) {
          target.state.is_alive = false;
          broadcastAll({ type: "player_died", player_id: targetId, killer_id: sessionId });
          console.log(`${targetId} died!`);

          // Респавн через 5 секунд
          setTimeout(() => {
            if (!clients.has(targetId)) return;
            target.state.hp = MAX_HP;
            target.state.is_alive = true;
            target.state.x = (Math.random() - 0.5) * 600;
            target.state.y = (Math.random() - 0.5) * 400;
            target.ws.send(JSON.stringify({ type: "respawn", data: target.state }));
            broadcast({ type: "player_update", player_id: targetId, data: target.state }, target.ws);
            console.log(`${targetId} respawned!`);
          }, RESPAWN_MS);
        }
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(sessionId);
    broadcastAll({ type: "player_left", player_id: sessionId });
    console.log(`[-] ${sessionId} left. Total: ${clients.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[!] Error for ${sessionId}:`, err.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🐛 Chitin server on ws://localhost:${PORT}`);
});
