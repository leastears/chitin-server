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
const larvaStates = new Map();
const meatStates = new Map(); // authoritative "body chunks" after player death
const FOOD_SPAWN_COUNT = 30;
const FOOD_RESPAWN_DELAY = 2000; // 2 сек
const LARVA_SPAWN_COUNT = 18;
const LARVA_RESPAWN_DELAY = 2500; // 2.5 сек
const CLIENT_TIMEOUT_MS = 300000; // 5 минут (чтобы не сбрасывался XP при неактивной вкладке)
const MEAT_DESPAWN_MS = 30000;
// Keep spawns roughly within same limits as food AI walls.
// NOTE: реальная карта имеет форму полигона на клиенте (Background). Сервер пока не знает этот полигон,
// поэтому делаем более консервативные лимиты, чтобы убрать грубые спавны "за картой".
const MAP_LIMIT_X = 3600;
const MAP_LIMIT_Y = 2800;

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function randX() {
  // Карта по X примерно от -5000 до +4000 в мировых координатах
  return (Math.random() * 2 - 1) * (MAP_LIMIT_X * 0.95);
}

function randY() {
  // Карта по Y примерно от -3500 до +4500 в мировых координатах
  return (Math.random() * 2 - 1) * (MAP_LIMIT_Y * 0.95);
}

const fs = require("fs");

let mapData = null;
try {
  const raw = fs.readFileSync("./map.json", "utf8");
  mapData = JSON.parse(raw);
  console.log(`[Map] Loaded map.json with ${mapData.bounds?.length || 0} bounds points and ${mapData.obstacles?.length || 0} obstacles.`);
} catch (e) {
  console.log("[Map] No map.json found, using default ellipse bounds.");
}

function pointInPolygon(point, vs) {
  let x = point.x, y = point.y;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    let xi = vs[i].x, yi = vs[i].y;
    let xj = vs[j].x, yj = vs[j].y;
    let intersect = ((yi > y) != (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function randSpawnPos() {
  const a = MAP_LIMIT_X * 0.92;
  const b = MAP_LIMIT_Y * 0.92;
  let x = 0;
  let y = 0;
  for (let i = 0; i < 50; i++) {
    x = randX();
    y = randY();
    
    // Bounds check
    if (mapData && mapData.bounds && mapData.bounds.length > 2) {
      if (!pointInPolygon({x, y}, mapData.bounds)) continue;
    } else {
      const u = (x * x) / (a * a) + (y * y) / (b * b);
      if (u > 1) continue;
    }

    // Obstacle check
    let inObstacle = false;
    if (mapData && mapData.obstacles) {
      for (const obs of mapData.obstacles) {
        if (pointInPolygon({x, y}, obs)) {
          inObstacle = true;
          break;
        }
      }
    }
    
    if (!inObstacle) return { x, y };
  }
  return { x, y };
}

function initLarvae() {
  for (let i = 0; i < LARVA_SPAWN_COUNT; i++) {
    const larvaId = `larva_${i}`;
    const p = randSpawnPos();
    larvaStates.set(larvaId, {
      x: p.x,
      y: p.y,
      angle: Math.random() * Math.PI * 2,
      xp_value: Math.floor(Math.random() * 3) + 3,
    });
  }
  console.log(`[Larvae] Generated ${LARVA_SPAWN_COUNT} larvae items`);
}

function initFood() {
  for (let i = 0; i < FOOD_SPAWN_COUNT; i++) {
    const foodId = `food_${i}`;
    const p = randSpawnPos();
    foodStates.set(foodId, {
      x: p.x,
      y: p.y,
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
    const nextX = food.x + Math.cos(food.angle) * moveDistance;
    const nextY = food.y + Math.sin(food.angle) * moveDistance;

    let hitWall = false;
    
    if (mapData && mapData.bounds && mapData.bounds.length > 2) {
      if (!pointInPolygon({x: nextX, y: nextY}, mapData.bounds)) hitWall = true;
    } else {
      if (Math.abs(nextX) > MAP_LIMIT_X || Math.abs(nextY) > MAP_LIMIT_Y) hitWall = true;
    }
    
    if (!hitWall && mapData && mapData.obstacles) {
      for (const obs of mapData.obstacles) {
        if (pointInPolygon({x: nextX, y: nextY}, obs)) {
          hitWall = true;
          break;
        }
      }
    }

    if (hitWall) {
      // Отскок от стены
      food.angle += Math.PI + (Math.random() - 0.5);
      // Ограничиваем координаты на случай, если еда уже вылезла ( fallback )
      if (!mapData || !mapData.bounds) {
        food.x = Math.max(-MAP_LIMIT_X, Math.min(MAP_LIMIT_X, food.x));
        food.y = Math.max(-MAP_LIMIT_Y, Math.min(MAP_LIMIT_Y, food.y));
      }
    } else {
      food.x = nextX;
      food.y = nextY;
    }
  }
}

function pickPlayerDynamic(s) {
  return {
    x: s.x,
    y: s.y,
    rot_head: s.rot_head,
    jaw_open: s.jaw_open,
    is_alive: s.is_alive,
    is_moving: s.is_moving,
  };
}

function pickFoodDynamic(f) {
  return {
    x: f.x,
    y: f.y,
    angle: f.angle,
  };
}

function pickLarvaDynamic(l) {
  return {
    x: l.x,
    y: l.y,
    angle: l.angle,
  };
}

function broadcastExcept(exceptSessionId, msg) {
  const payload = JSON.stringify(msg);
  for (const [sid, client] of clients) {
    if (sid === exceptSessionId) continue;
    if (client.ws.readyState === 1) client.ws.send(payload);
  }
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v | 0));
}

function spawnMeatChunksOnDeath({ victimId, victimState, centerX, centerY }) {
  const victimXp = Math.max(0, (victimState && victimState.xp) | 0);

  // How many chunks: scales with XP a bit, but always at least a few.
  const n = clampInt(Math.ceil(victimXp / 10), 4, 18);

  // Distribute XP exactly (no loss, no dupes).
  const base = n > 0 ? Math.floor(victimXp / n) : 0;
  const rem = n > 0 ? victimXp % n : 0;

  const spawnedIds = [];

  for (let i = 0; i < n; i++) {
    const xpValue = base + (i < rem ? 1 : 0);
    const meatId = `meat_${victimId}_${Date.now().toString(36)}_${i}`;

    const landMs = 450 + Math.floor(Math.random() * 200);
    const a = Math.random() * Math.PI * 2;
    const r = 40 + Math.random() * 140;
    const x = centerX + Math.cos(a) * r;
    const y = centerY + Math.sin(a) * r;
    const rotStart = Math.random() * Math.PI * 2;
    const rotEnd = rotStart + (Math.random() * 2 - 1) * Math.PI * 1.2;

    const data = {
      start_x: centerX,
      start_y: centerY,
      x,
      y,
      rot_start: rotStart,
      rot_end: rotEnd,
      land_ms: landMs,
      xp_value: xpValue,
      heal_amount: 5.0,
      victim_id: victimId,
      part_index: i, // client will map to a sprite part if available
    };

    meatStates.set(meatId, data);
    broadcastAll({ type: "meat_spawned", meat_id: meatId, data });
    spawnedIds.push(meatId);
  }

  // Despawn leftovers after some time (if not eaten).
  if (spawnedIds.length > 0) {
    setTimeout(() => {
      for (const id of spawnedIds) {
        if (meatStates.has(id)) {
          meatStates.delete(id);
          broadcastAll({ type: "meat_removed", meat_id: id });
        }
      }
    }, MEAT_DESPAWN_MS);
  }
}

wss.on("connection", (ws) => {
  const sessionId = genId();
  const client = { ws, sessionId, lastPing: Date.now() };
  clients.set(sessionId, client);

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
  const larvae = {};
  for (const [id, lstate] of larvaStates) {
    larvae[id] = lstate;
  }
  const meat = {};
  for (const [id, mstate] of meatStates) {
    meat[id] = mstate;
  }
  ws.send(JSON.stringify({ type: "full_state", players, food, larvae, meat }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      client.lastPing = Date.now();

      if (msg.type === "ping") {
        const ts = msg.timestamp || (msg.data ? msg.data.timestamp : null);
        ws.send(JSON.stringify({ type: "pong", timestamp: ts }));
        return;
      } else if (msg.type === "join") {
        // Register the player only when they explicitly "join" the game.
        if (playerStates.has(sessionId)) return;

        const joinData = msg.data || msg || {};
        const requestedName = typeof joinData.name === "string" ? joinData.name : "";
        const name = requestedName && requestedName.trim() ? requestedName.trim() : `Worm_${sessionId.slice(0, 4)}`;

        const spawn = randSpawnPos();
        const playerState = {
          x: spawn.x,
          y: spawn.y,
          rot_head: 0,
          jaw_open: 0,
          hp: 100,
          is_alive: true,
          is_moving: false,
          name,
          xp: 0,
        };
        playerStates.set(sessionId, playerState);

        // Send a fresh full_state snapshot to the joining client (so they see current world).
        const players = {};
        for (const [id, state] of playerStates) {
          players[id] = state;
        }
        const food = {};
        for (const [id, fstate] of foodStates) {
          food[id] = fstate;
        }
        const larvae = {};
        for (const [id, lstate] of larvaStates) {
          larvae[id] = lstate;
        }
        const meat = {};
        for (const [id, mstate] of meatStates) {
          meat[id] = mstate;
        }
        ws.send(JSON.stringify({ type: "full_state", players, food, larvae, meat }));

        // Tell everyone (including this client via world_sync/pull; but keep symmetry)
        broadcastExcept(sessionId, {
          type: "player_joined",
          player_id: sessionId,
          data: playerState,
        });
        return;
      } else if (msg.type === "input") {
        const state = playerStates.get(sessionId);
        if (!state) return;
        const input = msg.data || msg;
        // name changes are rare -> propagate only on change
        if (typeof input.name === "string" && input.name && input.name !== state.name) {
          state.name = input.name;
          broadcastAll({ type: "player_update", player_id: sessionId, data: { name: state.name } });
        }
        state.rot_head = input.target_angle ?? input.rot_head ?? state.rot_head;
        state.is_moving = input.is_moving ?? false;
        state.jaw_open = input.jaw_open ?? 0;
        if (typeof input.x === "number" && typeof input.y === "number") {
          state.x = input.x;
          state.y = input.y;
        }
        // XP на сервере авторитарный: клиент может предсказывать локально,
        // но не должен перезатирать серверный XP своим input (иначе у других будет 0).
      } else if (msg.type === "bite") {
        const state = playerStates.get(sessionId);
        if (!state) return;
        const targetId = msg.target_id;
        const charge = Math.min(Math.max(msg.charge ?? 0.5, 0), 1);
        const partName = typeof msg.part_name === "string" ? msg.part_name.slice(0, 64) : "";
        const targetState = playerStates.get(targetId);

        if (targetState && targetState.is_alive && state.is_alive) {
          const dx = state.x - targetState.x;
          const dy = state.y - targetState.y;
          const distSq = dx * dx + dy * dy;

          if (distSq <= 80 * 80 * 4) {
            const damage = 20 * charge;
            targetState.hp = Math.max(0, targetState.hp - damage);
            console.log(`${sessionId} bit ${targetId} for ${damage.toFixed(1)} dmg`);

            // Send hit to victim (for local feedback), and hp update to everyone
            const victim = clients.get(targetId);
            if (victim && victim.ws.readyState === 1) {
              victim.ws.send(JSON.stringify({ type: "hit", damage, attacker_id: sessionId, part_name: partName }));
            }
            broadcastAll({
              type: "player_update",
              player_id: targetId,
              data: { hp: targetState.hp },
            });

            if (targetState.hp <= 0) {
              targetState.is_alive = false;
              broadcastAll({
                type: "player_update",
                player_id: targetId,
                data: { is_alive: false, hp: 0 },
              });
              broadcastAll({
                type: "player_died",
                player_id: targetId,
                killer_id: sessionId,
              });

              // Spawn shared body chunks (authoritative meat items).
              spawnMeatChunksOnDeath({
                victimId: targetId,
                victimState: targetState,
                centerX: targetState.x,
                centerY: targetState.y,
              });

              setTimeout(() => {
                if (playerStates.has(targetId)) {
                  const p = playerStates.get(targetId);
                  p.hp = 100;
                  p.xp = 0;
                  p.is_alive = true;
                  p.x = randX();
                  p.y = randY();
                  broadcastAll({
                    type: "player_update",
                    player_id: targetId,
                    data: { hp: 100, xp: 0, is_alive: true, x: p.x, y: p.y },
                  });
                }
              }, 5000);
            }
          }
        }
      } else if (msg.type === "chat") {
        const state = playerStates.get(sessionId);
        if (!state) return;
        broadcastAll({
          type: "chat",
          player_id: sessionId,
          name: state.name,
          text: String(msg.text || "").slice(0, 100),
        });
      } else if (msg.type === "eat") {
        const state = playerStates.get(sessionId);
        if (!state) return;
        const foodId = msg.food_id;
        const isLarva = typeof foodId === "string" && foodId.startsWith("larva_");
        const foodState = isLarva ? larvaStates.get(foodId) : foodStates.get(foodId);
        
        if (foodState) {
          // Валидируем расстояние
          const dx = state.x - foodState.x;
          const dy = state.y - foodState.y;
          const distSq = dx * dx + dy * dy;
          
          if (distSq <= 100 * 100) { // 100px range
            const xpGain = foodState.xp_value || 5;
            state.xp = (state.xp || 0) + xpGain;

            broadcastAll({
              type: "player_update",
              player_id: sessionId,
              data: { xp: state.xp },
            });
            
            if (isLarva) {
              larvaStates.delete(foodId);
            } else {
              foodStates.delete(foodId);
            }
            console.log(`${sessionId} ate ${foodId}, gained ${xpGain} XP (total: ${state.xp})`);
            
            // Broadcast removal
            if (isLarva) {
              broadcastAll({ type: "larva_removed", larva_id: foodId });
            } else {
              broadcastAll({ type: "food_removed", food_id: foodId });
            }
            
            // Respawn (food_* / larva_*).
            setTimeout(() => {
              if (isLarva) {
                const p = randSpawnPos();
                larvaStates.set(foodId, {
                  x: p.x,
                  y: p.y,
                  angle: Math.random() * Math.PI * 2,
                  xp_value: Math.floor(Math.random() * 3) + 3,
                });
                const v = larvaStates.get(foodId);
                broadcastAll({
                  type: "larva_spawned",
                  larva_id: foodId,
                  x: v.x,
                  y: v.y,
                  xp_value: v.xp_value,
                });
              } else {
                const p = randSpawnPos();
                foodStates.set(foodId, {
                  x: p.x,
                  y: p.y,
                  angle: Math.random() * Math.PI * 2,
                  speed: 0.5 + Math.random() * 0.5,
                  xp_value: Math.floor(Math.random() * 4) + 4,
                });
                const v = foodStates.get(foodId);
                broadcastAll({
                  type: "food_spawned",
                  food_id: foodId,
                  x: v.x,
                  y: v.y,
                  xp_value: v.xp_value,
                });
              }
            }, isLarva ? LARVA_RESPAWN_DELAY : FOOD_RESPAWN_DELAY);
          }
        }
      } else if (msg.type === "eat_meat") {
        const state = playerStates.get(sessionId);
        if (!state) return;

        const meatId = msg.meat_id;
        const m = meatStates.get(meatId);
        if (!m) return;

        const dx = state.x - m.x;
        const dy = state.y - m.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= 110 * 110) {
          const xpGain = (m.xp_value || 0) | 0;
          state.xp = (state.xp || 0) + xpGain;
          broadcastAll({ type: "player_update", player_id: sessionId, data: { xp: state.xp } });

          meatStates.delete(meatId);
          broadcastAll({ type: "meat_removed", meat_id: meatId });
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
  // Cleanup stale/disconnected clients (prevents "ghost" players on abrupt tab close)
  const now = Date.now();
  for (const [sid, client] of clients) {
    const ws = client.ws;
    const stale = now - (client.lastPing || 0) > CLIENT_TIMEOUT_MS;
    const closed = !ws || ws.readyState === 3; // CLOSED
    if (stale || closed) {
      try {
        if (ws && ws.readyState === 1) ws.terminate();
      } catch (_) {}
      clients.delete(sid);
      const hadPlayer = playerStates.delete(sid);
      if (hadPlayer) {
        console.log(`[-] ${sid} timeout (${clients.size} online)`);
        broadcastAll({ type: "player_left", player_id: sid });
      }
    }
  }

  // Обновляем AI еды
  updateFoodAI();

  // Общий снапшот для всех (стабильнее и меньше дерганья на клиенте)
  const players = {};
  for (const [id, state] of playerStates) {
    players[id] = pickPlayerDynamic(state);
  }
  const food = {};
  for (const [id, fstate] of foodStates) {
    food[id] = pickFoodDynamic(fstate);
  }
  const larvae = {};
  for (const [id, lstate] of larvaStates) {
    larvae[id] = pickLarvaDynamic(lstate);
  }

  const payload = JSON.stringify({
    type: "world_sync",
    players,
    food,
    larvae,
  });

  for (const [, client] of clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(payload);
    }
  }
}, 50);

// v20260428-0336 Restart Trigger
initFood(); // Initialize food before starting server
initLarvae(); // Initialize larvae before starting server
httpServer.listen(PORT, () => {
  console.log(`\n🐛 Chitin ws://localhost:${PORT} (READY)\n`);
});
