import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import {
  ROOM_KEY,
  ROOMS_EXPIRY_KEY,
  ROOMS_GEO_KEY,
  getRedis,
} from "../lib/redis.js";
import { mapWs } from "../lib/ws-instance.js";

const router: IRouter = Router();

const CREATE_ROOM_SCRIPT = `
local geoKey = KEYS[1]
local expiryKey = KEYS[2]
local roomKey = KEYS[3]
local roomId = ARGV[1]
local lon = ARGV[2]
local lat = ARGV[3]
local name = ARGV[4]
local creatorId = ARGV[5]
local expiryTs = ARGV[6]
local radiusKm = ARGV[7]
local createdAt = ARGV[8]
redis.call('GEOADD', geoKey, lon, lat, roomId)
redis.call('ZADD', expiryKey, expiryTs, roomId)
redis.call('HSET', roomKey, 'id', roomId, 'name', name, 'creatorId', creatorId, 'userCount', '0', 'lon', lon, 'lat', lat, 'radiusKm', radiusKm, 'createdAt', createdAt)
redis.call('EXPIRE', roomKey, 300)
return 1
`;

const NEARBY_ROOMS_SCRIPT = `
local ids = redis.call('GEOSEARCH', KEYS[1], 'FROMLONLAT', ARGV[1], ARGV[2], 'BYRADIUS', ARGV[3], 'km', 'ASC', 'COUNT', '50')
return ids
`;

function generateRoomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

router.post("/rooms", async (req: Request, res: Response): Promise<void> => {
  const { name, lat, lng, radiusKm, creatorId } = req.body as {
    name?: unknown;
    lat?: unknown;
    lng?: unknown;
    radiusKm?: unknown;
    creatorId?: unknown;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Room name is required" });
    return;
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    res
      .status(400)
      .json({ error: "Valid latitude and longitude are required" });
    return;
  }
  if (!creatorId || typeof creatorId !== "string") {
    res.status(400).json({ error: "Creator ID is required" });
    return;
  }

  const radius =
    typeof radiusKm === "number" ? Math.min(Math.max(radiusKm, 0.1), 100) : 5;
  const roomId = generateRoomId();
  const now = Date.now();
  const expiryTs = now + 24 * 60 * 60 * 1000;

  try {
    const redis = getRedis();
    await redis.eval(
      CREATE_ROOM_SCRIPT,
      3,
      ROOMS_GEO_KEY,
      ROOMS_EXPIRY_KEY,
      ROOM_KEY(roomId),
      roomId,
      lng.toString(),
      lat.toString(),
      name.trim(),
      creatorId,
      expiryTs.toString(),
      radius.toString(),
      now.toString(),
    );

    req.log.info({ roomId, name: name.trim(), lat, lng }, "Room created");
    res.status(201).json({
      id: roomId,
      name: name.trim(),
      lat,
      lng,
      radiusKm: radius,
      creatorId,
      userCount: 0,
      createdAt: now,
    });
    if (!mapWs) {
      req.log.warn("Map WS not ready");
    } else {
      mapWs?.broadcastRoomCreated({
        id: roomId,
        name: name.trim(),
        lat,
        lng,
        radiusKm: radius,
        creatorId,
        userCount: 0,
        createdAt: now,
      });
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create room");
    res.status(500).json({ error: "Failed to create room" });
  }
});

router.get(
  "/rooms/nearby",
  async (req: Request, res: Response): Promise<void> => {
    const lat = parseFloat(req.query["lat"] as string);
    const lng = parseFloat(req.query["lng"] as string);
    const radiusKm = parseFloat(req.query["radiusKm"] as string) || 5;

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      res
        .status(400)
        .json({ error: "Valid lat and lng query params required" });
      return;
    }

    try {
      const redis = getRedis();

      const now = Date.now();
      const expiredIds = await redis.zrangebyscore(
        ROOMS_EXPIRY_KEY,
        "-inf",
        now,
      );
      if (expiredIds.length > 0) {
        await redis.zremrangebyscore(ROOMS_EXPIRY_KEY, "-inf", now);
        await redis.zrem(ROOMS_GEO_KEY, ...expiredIds);
        if (expiredIds.length > 0) {
          await redis.del(expiredIds.map((id: any) => ROOM_KEY(id)));
        }
      }

      const roomIds = (await redis.eval(
        NEARBY_ROOMS_SCRIPT,
        1,
        ROOMS_GEO_KEY,
        lng.toString(),
        lat.toString(),
        radiusKm.toString(),
      )) as string[];

      const rooms = await Promise.all(
        (roomIds ?? []).map(async (roomId) => {
          const meta = await redis.hgetall(ROOM_KEY(roomId));
          if (!meta || !meta["name"]) return null;
          const roomLat = parseFloat(meta["lat"] ?? "0");
          const roomLng = parseFloat(meta["lon"] ?? "0");
          const dLat = ((roomLat - lat) * Math.PI) / 180;
          const dLng = ((roomLng - lng) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((lat * Math.PI) / 180) *
              Math.cos((roomLat * Math.PI) / 180) *
              Math.sin(dLng / 2) ** 2;
          const distance =
            6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return {
            id: roomId,
            name: meta["name"],
            lat: roomLat,
            lng: roomLng,
            radiusKm: parseFloat(meta["radiusKm"] ?? "5"),
            userCount: Math.max(0, parseInt(meta["userCount"] ?? "0", 10)),
            creatorId: meta["creatorId"] ?? "",
            createdAt: parseInt(meta["createdAt"] ?? "0", 10),
            distance: Math.round(distance * 10) / 10,
          };
        }),
      );

      res.json({ rooms: rooms.filter(Boolean) });
    } catch (err) {
      req.log.error({ err }, "Failed to fetch nearby rooms");
      res.status(500).json({ error: "Failed to fetch nearby rooms" });
    }
  },
);

export default router;
