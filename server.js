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

    this.onMessage("input", (client, d) => {
      if (this.state.players[client.sessionId]) {
        const p = this.state.players[client.sessionId];
        p.x = d.x ?? p.x;
        p.y = d.y ?? p.y;
        p.rot_head = d.rot_head ?? p.rot_head;
        p.jaw_open = d.jaw_open ?? p.jaw_open;
        p.is_moving = d.is_moving ?? p.is_moving;
        p.name = d.name || p.name;
        
        // Трансляция остальным
        this.broadcast("player_update", {
          player_id: client.sessionId,
          data: p
        }, { except: client });
      }
    });

    this.onMessage("bite", (client, msg) => {
      const targetId = msg.target_id;
      const target = this.state.players[targetId];
      if (target && target.is_alive) {
        const damage = (msg.charge || 0.5) * 20;
        target.hp -= damage;
        this.broadcast("hit", { 
          player_id: targetId, 
          damage: damage,
          attacker_id: client.sessionId
        });
        
        if (target.hp <= 0) {
          target.is_alive = false;
          this.broadcast("player_died", { 
            player_id: targetId, 
            killer_id: client.sessionId 
          });
        }
      }
    });

    this.onMessage("chat", (client, msg) => {
      const p = this.state.players[client.sessionId];
      const data = msg.data || msg; // На случай если прислали без data
      if (p && data.text) {
        this.broadcast("chat", {
          name: p.name,
          text: data.text
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

    client.send("welcome", { session_id: client.sessionId });
    client.send("full_state", { players: this.state.players });
    this.broadcast("player_joined", { 
      player_id: client.sessionId, 
      data: playerData 
    }, { except: client });
  }

  onLeave(client, consented) {
    console.log(client.sessionId, "left!");
    
    // Сохраняем сессию на 5 минут
    const player = this.state.players[client.sessionId];
    if (player && player.is_alive) {
      this.deadSessions.set(client.sessionId, {
        time: Date.now(),
        data: player
      });
    }
    
    delete this.state.players[client.sessionId];
    this.broadcast("player_left", { player_id: client.sessionId });
    
    // Чистим старые сессии каждые раз когда кто то выходит
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
