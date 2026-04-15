import { createServer, IncomingMessage } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { getRedis } from "./lib/redis.js";
import "dotenv/config";
import type { Socket } from "net";

import { WebSocketServer } from "ws";
import { handleMainWS } from "./lib/websocket.js";
import { handleMapWS, mapWsInstance } from "./lib/map-ws.js";
import { setMapWsInstance } from "./lib/ws-instance.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ✅ Start Redis early
(async () => {
  await getRedis();
})();

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const url = new URL(req.url ?? "", "http://localhost");

  if (url.pathname === "/api/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleMainWS(ws, req);
    });
  } else if (url.pathname === "/api/ws/map") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleMapWS(ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ✅ expose map ws instance globally
setMapWsInstance(mapWsInstance);

server.on("error", (err: Error) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
