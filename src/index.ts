import "reflect-metadata";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "colyseus";
import { monitor } from "@colyseus/monitor";
import { WormRoom } from "./WormRoom";

const PORT = Number(process.env.PORT) || 2567;
const app = express();

app.use(cors());
app.use(express.json());

// Healthcheck для Railway
app.get("/", (_req, res) => {
  res.json({ status: "ok", game: "Chitin", players: "online" });
});

// Панель мониторинга Colyseus (только в dev)
if (process.env.NODE_ENV !== "production") {
  app.use("/colyseus", monitor());
}

const httpServer = createServer(app);

const gameServer = new Server({ server: httpServer });

// Регистрируем комнату
gameServer.define("worm_room", WormRoom);

gameServer.listen(PORT).then(() => {
  console.log(`\n🐛 Chitin server running on ws://localhost:${PORT}`);
  console.log(`   Monitor: http://localhost:${PORT}/colyseus\n`);
});
