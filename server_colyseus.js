// Chitin Server - Stable Rollback (Deploy: 2026-04-28)
const http = require('http');
const express = require('express');
const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 2567;

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Упрощенная комната для Godot (протокол от 24 апреля)
class WormRoom extends require('colyseus').Room {
  onCreate(options) {
    this.setState({
      players: {},
      food: {},
      larvae: {}
    });
    
    this.deadSessions = new Map();
    this.SESSION_TTL = 5 * 60 * 1000; // 5 минут
    this.lastActivity = new Map();
    this.IDLE_TIMEOUT = 45 * 1000; // 45 секунд до статуса AFK
    this.DISCONNECT_TIMEOUT = 5 * 60 * 1000; // 5 минут до реального дисконнекта

    // Главный симуляционный цикл (Тикрейт 20 Гц)
    this.setSimulationInterval(() => {
      const now = Date.now();
      
      // 1. Мониторинг активности и очистка
      for (const [sessionId, player] of Object.entries(this.state.players)) {
        const last = this.lastActivity.get(sessionId) || now;
        
        if (now - last > this.IDLE_TIMEOUT && !player.is_idle) {
          player.is_idle = true;
          this.broadcast("player_idle", { type: "player_idle", player_id: sessionId });
        }
        
        if (now - last > this.DISCONNECT_TIMEOUT) {
          this.disconnectPlayer(sessionId);
          continue;
        }
      }

      // 2. Рассылка состояния мира ВСЕМ (даже если кто-то спит в фоне)
      // Конвертируем Colyseus MapSchema в обычный чистый объект для Godot
      const players = {};
      for (const id in this.state.players) {
        players[id] = Object.assign({}, this.state.players[id]);
      }
      
      this.broadcast("world_sync", { type: "world_sync", players: players });
      
    }, 50); // 20 раз в секунду

    this.onMessage("input", (client, msg) => {
      if (this.state.players[client.sessionId]) {
        this.lastActivity.set(client.sessionId, Date.now());
        const p = this.state.players[client.sessionId];
        p.is_idle = false;
        
        // Универсальное извлечение данных (из корня или из .data)
        const d = msg.data || msg;
        
        p.x = d.x ?? p.x;
        p.y = d.y ?? p.y;
        p.rot_head = d.rot_head ?? p.rot_head;
        p.jaw_open = d.jaw_open ?? p.jaw_open;
        p.is_moving = d.is_moving ?? p.is_moving;
        p.name = d.name || p.name;
        p.xp = d.xp ?? p.xp;
      }
    });

    this.onMessage("ping", (client) => {
      this.lastActivity.set(client.sessionId, Date.now());
    });

    this.onMessage("bite", (client, msg) => {
      const attacker = this.state.players[client.sessionId];
      const targetId = msg.target_id;
      const target = this.state.players[targetId];
      
      if (!attacker || !target || !target.is_alive || !attacker.is_alive) return;
      
      // ✅ ВЕСЬ РАСЧЁТ УРОНА ТОЛЬКО НА СЕРВЕРЕ
      const damage = Math.max(5, Math.min(40, (msg.charge || 0.5) * 40));
      target.hp -= damage;
      
      this.broadcast("hit", { 
        type: "hit",
        player_id: targetId, 
        damage: damage,
        attacker_id: client.sessionId
      });
      
      if (target.hp <= 0) {
        target.hp = 0;
        target.is_alive = false;
        
        this.broadcast("player_died", { 
          type: "player_died",
          player_id: targetId, 
          killer_id: client.sessionId 
        });
        
        this.deadSessions.delete(targetId);
        this.lastActivity.delete(targetId);
      }
    });

    this.onMessage("chat", (client, msg) => {
      const p = this.state.players[client.sessionId];
      if (p && msg.text) {
        this.broadcast("chat", {
          type: "chat",
          player_id: client.sessionId,
          name: p.name,
          text: msg.text
        });
      }
    });
  }

  onJoin(client, options) {
    let playerData = null;
    
    // Пытаемся восстановить сессию
    if (options.session_id && this.deadSessions.has(options.session_id)) {
      const saved = this.deadSessions.get(options.session_id);
      if (Date.now() - saved.time < this.SESSION_TTL) {
        playerData = saved.data;
        console.log("Restored session:", options.session_id);
        this.deadSessions.delete(options.session_id);
      }
    }
    
    if (!playerData) {
      // Новый игрок
      playerData = {
        x: Math.random() * 2000 - 1000,
        y: Math.random() * 2000 - 1000,
        rot_head: 0,
        hp: 100,
        is_alive: true,
        name: options.name || "Worm",
        jaw_open: 0,
        is_moving: false,
        xp: 0
      };
    }
    
    this.state.players[client.sessionId] = playerData;

    client.send("welcome", { type: "welcome", session_id: client.sessionId });
    client.send("full_state", { type: "full_state", players: this.state.players });
    this.broadcast("player_joined", { 
      type: "player_joined",
      player_id: client.sessionId, 
      data: playerData 
    }, { except: client });
  }

  onLeave(client, consented) {
    // Не удаляем игрока сразу, ставим статус оффлайн
    const player = this.state.players[client.sessionId];
    if (player) {
      player.is_offline = true;
      this.lastActivity.set(client.sessionId, Date.now());
      this.broadcast("player_offline", { type: "player_offline", player_id: client.sessionId });
      console.log(client.sessionId, "socket closed, keeping player in world for 5 min");
    }
  }
  
  disconnectPlayer(sessionId) {
    const player = this.state.players[sessionId];
    
    // Сохраняем сессию только если игрок жив
    if (player && player.is_alive) {
      this.deadSessions.set(sessionId, {
        time: Date.now(),
        data: player
      });
    }
    
    delete this.state.players[sessionId];
    this.lastActivity.delete(sessionId);
    this.broadcast("player_left", { type: "player_left", player_id: sessionId });
    console.log(sessionId, "permanently removed from world");
    
    // Чистим старые сессии
    const now = Date.now();
    for (const [id, entry] of this.deadSessions) {
      if (now - entry.time > this.SESSION_TTL) {
        this.deadSessions.delete(id);
      }
    }
  }
}

gameServer.define('worm_room', WormRoom);

app.get('/', (req, res) => {
  res.send('🐛 Chitin Server is running (Stable April 24 Protocol)');
});

httpServer.listen(PORT, () => {
  console.log(`\n🐛 Chitin server on ws://localhost:${PORT}`);
});
