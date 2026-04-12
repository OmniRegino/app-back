import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { getRedis } from "./lib/redis";
import { setupWebSocketServer } from "./lib/websocket";
import "dotenv/config";

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

// Eagerly start Redis connection so it's ready before first request
getRedis();

const server = createServer(app);
setupWebSocketServer(server);

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
