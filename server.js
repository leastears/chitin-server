// Chitin Server - Stable Rollback (Deploy: 2026-04-27 23:06)
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
      if (p) {
        this.broadcast("chat", {
          name: p.name,
          text: msg.text
        });
      }
    });
  }

  onJoin(client, options) {
    console.log(client.sessionId, "joined!");
    const p = {
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
    this.state.players[client.sessionId] = p;

    client.send("welcome", { session_id: client.sessionId });
    client.send("full_state", { players: this.state.players });
    this.broadcast("player_joined", { 
      player_id: client.sessionId, 
      data: p 
    }, { except: client });
  }

  onLeave(client, consented) {
    console.log(client.sessionId, "left!");
    delete this.state.players[client.sessionId];
    this.broadcast("player_left", { player_id: client.sessionId });
  }
}

gameServer.define('worm_room', WormRoom);

app.get('/', (req, res) => {
  res.send('🐛 Chitin Server is running (Stable April 24 Protocol)');
});

httpServer.listen(PORT, () => {
  console.log(`\n🐛 Chitin server on ws://localhost:${PORT}`);
});
