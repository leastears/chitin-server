import { Schema, type, MapSchema } from "@colyseus/schema";

export class WormState extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") rot_head: number = 0;
  @type("float32") jaw_open: number = 0;
  @type("float32") hp: number = 100;
  @type("float32") max_hp: number = 100;
  @type("boolean") is_alive: boolean = true;
  @type("boolean") is_moving: boolean = false;
  // Имя игрока для отображения
  @type("string") player_name: string = "Worm";
}

export class RoomState extends Schema {
  @type({ map: WormState }) players = new MapSchema<WormState>();
}
