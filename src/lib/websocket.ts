import type { IncomingMessage } from "http";
import type { Server } from "http";
import { URL } from "url";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { MESSAGES_KEY, ROOM_KEY, getRedis } from "./redis.js";

interface Client {
  ws: WebSocket & { isAlive?: boolean };
  userId: string;
  username: string;
  roomId: string;
}

const rooms = new Map<string, Set<Client>>();
const ROOM_TTL = 60 * 5;
const MAX_MESSAGE_BYTES = 4096;
const HEARTBEAT_INTERVAL = 30_000;

function broadcast(roomId: string, data: object, exclude?: Client) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const client of room) {
    if (client !== exclude && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

export function setupWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/api/ws" });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((rawWs: WebSocket) => {
      const ws = rawWs as WebSocket & { isAlive?: boolean };
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", async (rawWs: WebSocket, req: IncomingMessage) => {
    const ws = rawWs as WebSocket & { isAlive?: boolean };
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const url = new URL(req.url ?? "/", "http://localhost");
    const roomId = url.searchParams.get("roomId");
    const userId = url.searchParams.get("userId");
    const username = url.searchParams.get("username");

    if (!roomId || !userId || !username) {
      ws.close(1008, "Missing required params");
      return;
    }

    const redis = getRedis();
    const roomExists = await redis.exists(ROOM_KEY(roomId));
    if (!roomExists) {
      ws.close(1008, "Room not found");
      return;
    }

    const client: Client = { ws, userId, username, roomId };

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId)!.add(client);

    await redis.hincrby(ROOM_KEY(roomId), "userCount", 1);
    const countStr = await redis.hget(ROOM_KEY(roomId), "userCount");
    const userCount = Math.max(0, parseInt(countStr ?? "0", 10));

    const history = await redis.lrange(MESSAGES_KEY(roomId), -50, -1);
    const messages = history
      .map((m: WebSocket.RawData) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    ws.send(JSON.stringify({ type: "history", messages }));
    broadcast(roomId, { type: "join", username, userId, userCount }, client);
    ws.send(JSON.stringify({ type: "joined", username, userId, userCount }));

    logger.info({ roomId, userId, username }, "User joined room");

    ws.on("message", async (data: Buffer) => {
      if (data.length > MAX_MESSAGE_BYTES) {
        ws.send(
          JSON.stringify({ type: "error", message: "Message too large" }),
        );
        return;
      }
      let parsed: { type: string; content?: string };
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }
      if (parsed.type === "message" && parsed.content) {
        const content = parsed.content.trim();
        if (!content) return;

        const message = {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          userId,
          username,
          content,
          timestamp: Date.now(),
        };

        await redis.rpush(MESSAGES_KEY(roomId), JSON.stringify(message));
        await redis.expire(MESSAGES_KEY(roomId), ROOM_TTL);
        broadcast(roomId, { type: "message", ...message });
      }
    });

    ws.on("close", async () => {
      rooms.get(roomId)?.delete(client);
      if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);

      await redis.hincrby(ROOM_KEY(roomId), "userCount", -1);
      const newStr = await redis.hget(ROOM_KEY(roomId), "userCount");
      const finalCount = Math.max(0, parseInt(newStr ?? "0", 10));
      broadcast(roomId, {
        type: "leave",
        username,
        userId,
        userCount: finalCount,
      });
      logger.info({ roomId, userId, username }, "User left room");
    });

    ws.on("error", (err: Error) => {
      logger.error({ err, roomId, userId }, "WebSocket client error");
    });
  });

  logger.info("WebSocket server ready at /api/ws");
  return wss;
}
