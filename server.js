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
const foodStates = new Map();
const FOOD_SPAWN_COUNT = 30;
const FOOD_RESPAWN_DELAY = 2000; // 2 сек

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function randX() {
  // Карта по X примерно от -5000 до +4000 в мировых координатах
  return (Math.random() - 0.5) * 8000;
}

function randY() {
  // Карта по Y примерно от -3500 до +4500 в мировых координатах
  return (Math.random() - 0.5) * 7000 + 500;
}

function initFood() {
  for (let i = 0; i < FOOD_SPAWN_COUNT; i++) {
    const foodId = `food_${i}`;
    foodStates.set(foodId, {
      x: randX(),
      y: randY(),
      angle: Math.random() * Math.PI * 2,
      speed: 0.5 + Math.random() * 0.5,
      xp_value: Math.floor(Math.random() * 4) + 4,
    });
  }
  console.log(`[Food] Generated ${FOOD_SPAWN_COUNT} food items`);
}

function updateFoodAI() {
  const FLEE_DIST = 300;
  const FLEE_SPEED = 2.0;
  const MAP_LIMIT_X = 4500;
  const MAP_LIMIT_Y = 3500;

  for (const [, food] of foodStates) {
    // --- Логика убегания от игроков ---
    let fleeX = 0;
    let fleeY = 0;
    let hasThreat = false;

    for (const [, p] of playerStates) {
      if (!p.is_alive) continue;
      const dx = food.x - p.x;
      const dy = food.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < FLEE_DIST && dist > 1) {
        // Сила отталкивания: чем ближе, тем сильнее
        const force = (FLEE_DIST - dist) / FLEE_DIST;
        fleeX += (dx / dist) * force;
        fleeY += (dy / dist) * force;
        hasThreat = true;
      }
    }

    if (hasThreat) {
      // Убегаем — разворачиваемся в сторону суммарной силы отталкивания
      food.angle = Math.atan2(fleeY, fleeX);
      food.speed = FLEE_SPEED;
    } else {
      // Обычное блуждание — иногда меняем направление
      if (Math.random() < 0.02) {
        food.angle = Math.random() * Math.PI * 2;
        food.speed = 0.5 + Math.random() * 0.5;
      }
    }

    // Двигаемся
    const moveDistance = food.speed * 0.5;
    food.x += Math.cos(food.angle) * moveDistance;
    food.y += Math.sin(food.angle) * moveDistance;

    // Остаемся в пределах карты
    if (Math.abs(food.x) > MAP_LIMIT_X) {
      food.x = Math.max(-MAP_LIMIT_X, Math.min(MAP_LIMIT_X, food.x));
      food.angle = Math.PI - food.angle;
    }
    if (Math.abs(food.y) > MAP_LIMIT_Y) {
      food.y = Math.max(-MAP_LIMIT_Y, Math.min(MAP_LIMIT_Y, food.y));
      food.angle = -food.angle;
    }
  }
}

wss.on("connection", (ws) => {
  const sessionId = genId();
  const client = { ws, sessionId, lastPing: Date.now() };
  clients.set(sessionId, client);

  const playerState = {
    x: randX(),
    y: randY(),
    rot_head: 0,
    jaw_open: 0,
    hp: 100,
    is_alive: true,
    is_moving: false,
    name: `Worm_${sessionId.slice(0, 4)}`,
    xp: 0,
  };
  playerStates.set(sessionId, playerState);

  console.log(`[+] ${sessionId} connected (${clients.size} online)`);

  // Welcome
  ws.send(JSON.stringify({ type: "welcome", session_id: sessionId }));

  // Full state with food
  const players = {};
  for (const [id, state] of playerStates) {
    players[id] = state;
  }
  const food = {};
  for (const [id, fstate] of foodStates) {
    food[id] = fstate;
  }
  ws.send(JSON.stringify({ type: "full_state", players, food }));

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
                  p.x = randX();
                  p.y = randY();
                }
              }, 5000);
            }
          }
        }
      } else if (msg.type === "chat") {
        broadcastAll({
          type: "chat",
          player_id: sessionId,
          name: state.name,
          text: String(msg.text || "").slice(0, 100),
        });
      } else if (msg.type === "eat") {
        const foodId = msg.food_id;
        const foodState = foodStates.get(foodId);
        
        if (foodState) {
          // Валидируем расстояние
          const dx = state.x - foodState.x;
          const dy = state.y - foodState.y;
          const distSq = dx * dx + dy * dy;
          
          if (distSq <= 100 * 100) { // 100px range
            const xpGain = foodState.xp_value || 5;
            state.xp = (state.xp || 0) + xpGain;
            
            foodStates.delete(foodId);
            console.log(`${sessionId} ate ${foodId}, gained ${xpGain} XP (total: ${state.xp})`);
            
            // Broadcast food removal
            broadcastAll({ type: "food_removed", food_id: foodId });
            
            // Respawn food later
            setTimeout(() => {
              foodStates.set(foodId, {
                x: randX(),
                y: randY(),
                angle: Math.random() * Math.PI * 2,
                speed: 0.5 + Math.random() * 0.5,
                xp_value: Math.floor(Math.random() * 4) + 4,
              });
              broadcastAll({
                type: "food_spawned",
                food_id: foodId,
                x: foodStates.get(foodId).x,
                y: foodStates.get(foodId).y,
                xp_value: foodStates.get(foodId).xp_value,
              });
            }, FOOD_RESPAWN_DELAY);
          }
        }
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
  // Обновляем AI еды
  updateFoodAI();
  
  const players = {};
  for (const [id, state] of playerStates) {
    players[id] = state;
  }
  const food = {};
  for (const [id, fstate] of foodStates) {
    food[id] = fstate;
  }

  const payload = JSON.stringify({
    type: "world_sync",
    players,
    food,
  });

  for (const [, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}, 50);

// v20260428-0336 Restart Trigger
initFood(); // Initialize food before starting server
httpServer.listen(PORT, () => {
  console.log(`\n🐛 Chitin ws://localhost:${PORT} (READY)\n`);
});
