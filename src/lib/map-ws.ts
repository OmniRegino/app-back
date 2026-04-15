import type { IncomingMessage } from "http";
import { URL } from "url";
import { WebSocket } from "ws";
import { getRedis, ROOMS_GEO_KEY, ROOM_KEY } from "./redis.js";
import { logger } from "./logger.js";

interface MapClient {
  ws: WebSocket;
  lat: number;
  lng: number;
  radiusKm: number;
}

const mapClients = new Set<MapClient>();
const clients = new Set<WebSocket>();

const DEFAULT_RADIUS_KM = 5;
const HEARTBEAT_INTERVAL = 30_000;

//distance calc
function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (v: number) => (v * Math.PI) / 180;

  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

//safe send
function safeSend(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

setInterval(() => {
  clients.forEach((ws) => {
    const client = ws as WebSocket & { isAlive?: boolean };

    if (client.isAlive === false) {
      ws.terminate();
      clients.delete(ws);

      for (const c of mapClients) {
        if (c.ws === ws) {
          mapClients.delete(c);
          break;
        }
      }

      return;
    }

    client.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

export async function handleMapWS(ws: WebSocket, req: IncomingMessage) {
  const clientWs = ws as WebSocket & { isAlive?: boolean };
  clientWs.isAlive = true;

  clients.add(ws);

  clientWs.on("pong", () => {
    clientWs.isAlive = true;
  });

  const url = new URL(req.url ?? "", "http://localhost");

  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lng = parseFloat(url.searchParams.get("lng") || "");
  const radiusKm =
    parseFloat(url.searchParams.get("radiusKm") || "") || DEFAULT_RADIUS_KM;

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    clientWs.close(1008, "Invalid coordinates");
    return;
  }

  const client: MapClient = { ws: clientWs, lat, lng, radiusKm };
  mapClients.add(client);

  logger.info({ lat, lng, radiusKm }, "Map client connected");

  try {
    const redis = getRedis();

    const roomIds = (await redis.geosearch(
      ROOMS_GEO_KEY,
      "FROMLONLAT",
      lng,
      lat,
      "BYRADIUS",
      radiusKm,
      "km",
      "ASC",
      "COUNT",
      50,
    )) as string[];

    const rooms = await Promise.all(
      roomIds.map(async (roomId) => {
        const meta = await redis.hgetall(ROOM_KEY(roomId));
        if (!meta || !meta.name) return null;

        return {
          id: roomId,
          name: meta.name,
          lat: parseFloat(meta.lat),
          lng: parseFloat(meta.lon),
          radiusKm: parseFloat(meta.radiusKm ?? "5"),
          userCount: parseInt(meta.userCount ?? "0", 10),
          creatorId: meta.creatorId,
          createdAt: parseInt(meta.createdAt ?? "0", 10),
        };
      }),
    );

    safeSend(clientWs, {
      type: "SNAPSHOT",
      rooms: rooms.filter(Boolean),
    });
  } catch (err) {
    logger.error({ err }, "Map snapshot failed");
  }

  clientWs.on("close", () => {
    clients.delete(ws);
    mapClients.delete(client);
    logger.info({ lat, lng }, "Map client disconnected");
  });

  clientWs.on("error", (err: Error) => {
    logger.error({ err }, "Map WS error");
    clientWs.close();
  });
}

export const mapWsInstance = {
  broadcastRoomCreated(room: any) {
    broadcast(room, "ROOM_CREATED");
  },

  broadcastRoomUpdated(room: any) {
    broadcast(room, "ROOM_UPDATED");
  },

  broadcastRoomDeleted(roomId: string, lat: number, lng: number) {
    for (const client of mapClients) {
      const distance = haversine(client.lat, client.lng, lat, lng);

      if (distance <= client.radiusKm) {
        safeSend(client.ws, {
          type: "ROOM_DELETED",
          roomId,
        });
      }
    }
  },
};

function broadcast(room: any, type: string) {
  for (const client of mapClients) {
    const distance = haversine(client.lat, client.lng, room.lat, room.lng);

    if (distance <= client.radiusKm) {
      safeSend(client.ws, {
        type,
        room,
      });
    }
  }
}
