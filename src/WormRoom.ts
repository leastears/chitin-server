import { Room, Client } from "colyseus";
import { RoomState, WormState } from "./WormSchema";

const MAX_HP = 100;
const MAX_DAMAGE_PER_BITE = 20;  // Максимальный урон за укус (защита от читов)
const BITE_RANGE_SQ = 80 * 80;   // Квадрат дистанции укуса (в пикселях)

export class WormRoom extends Room<RoomState> {
  maxClients = 16;

  onCreate(options: any) {
    this.setState(new RoomState());

    // Принимаем инпут от клиента (позиция + состояние)
    this.onMessage("input", (client, data) => {
      const worm = this.state.players.get(client.sessionId);
      if (!worm || !worm.is_alive) return;

      // Обновляем стейт этого игрока
      worm.x         = data.x         ?? worm.x;
      worm.y         = data.y         ?? worm.y;
      worm.rot_head  = data.rot_head  ?? worm.rot_head;
      worm.jaw_open  = data.jaw_open  ?? worm.jaw_open;
      worm.is_moving = data.is_moving ?? worm.is_moving;
    });

    // Клиент сообщает об укусе — сервер авторитарно проверяет и наносит урон
    this.onMessage("bite", (client, data) => {
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker || !attacker.is_alive) return;

      const targetId: string = data.target_id;
      const chargeRatio: number = Math.min(Math.max(data.charge ?? 0, 0), 1);
      
      const target = this.state.players.get(targetId);
      if (!target || !target.is_alive) return;

      // Серверная проверка дистанции (защита от читов)
      const dx = attacker.x - target.x;
      const dy = attacker.y - target.y;
      const distSq = dx * dx + dy * dy;

      if (distSq > BITE_RANGE_SQ * 4) {
        console.log(`[CHEAT?] ${client.sessionId} bite too far: ${Math.sqrt(distSq)}px`);
        return;
      }

      const damage = MAX_DAMAGE_PER_BITE * chargeRatio;
      target.hp = Math.max(0, target.hp - damage);

      console.log(`${client.sessionId} bit ${targetId} for ${damage.toFixed(1)} dmg. Target HP: ${target.hp}`);

      // Уведомляем жертву об укусе
      const targetClient = this.clients.find(c => c.sessionId === targetId);
      if (targetClient) {
        targetClient.send("hit", { damage, attacker_id: client.sessionId });
      }

      // Смерть
      if (target.hp <= 0 && target.is_alive) {
        target.is_alive = false;
        target.hp = 0;
        console.log(`${targetId} died!`);

        // Уведомляем всю комнату
        this.broadcast("player_died", { 
          player_id: targetId,
          killer_id: client.sessionId 
        });

        // Возрождение через 5 секунд
        setTimeout(() => {
          if (this.state.players.has(targetId)) {
            const respawned = this.state.players.get(targetId)!;
            respawned.hp = MAX_HP;
            respawned.is_alive = true;
            // Случайная позиция возрождения
            respawned.x = (Math.random() - 0.5) * 800;
            respawned.y = (Math.random() - 0.5) * 600;
            console.log(`${targetId} respawned!`);
          }
        }, 5000);
      }
    });

    console.log("[WormRoom] Created, waiting for players...");
  }

  onJoin(client: Client, options: any) {
    const worm = new WormState();
    // Случайная позиция для нового игрока
    worm.x = (Math.random() - 0.5) * 600;
    worm.y = (Math.random() - 0.5) * 400;
    worm.hp = MAX_HP;
    worm.max_hp = MAX_HP;
    worm.player_name = options?.name ?? `Worm_${client.sessionId.slice(0, 4)}`;

    this.state.players.set(client.sessionId, worm);
    console.log(`[+] ${client.sessionId} joined. Total: ${this.clients.length}`);
  }

  onLeave(client: Client, consented: boolean) {
    this.state.players.delete(client.sessionId);
    console.log(`[-] ${client.sessionId} left. Total: ${this.clients.length}`);
  }

  onDispose() {
    console.log("[WormRoom] Disposed.");
  }
}
