import IORedis from "ioredis";
import { logger } from "./logger.js";

let client: IORedis | null = null;

function cleanRedisUrl(raw: string): string {
  let s = raw.trim();

  // Strip URL-encoded quotes (%22) and literal quotes
  const junk = /^(%22|%27|"|')+|(%22|%27|"|')+$/g;

  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(junk, "").trim();
  }

  return s;
}

export function getRedis(): IORedis {
  if (client) return client;

  const rawUrl = process.env.REDIS_URL;
  if (!rawUrl) {
    throw new Error("REDIS_URL environment variable is not set");
  }

  const urlStr = cleanRedisUrl(rawUrl);

  logger.info(
    { urlStart: urlStr.slice(0, 12) },
    "Redis URL prefix (first 12 chars)",
  );

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch (e) {
    throw new Error(
      `Invalid REDIS_URL (could not parse): ${(e as Error).message}`,
    );
  }

  const isTls = parsed.protocol === "rediss:";
  const host = parsed.hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : isTls ? 6380 : 6379;

  const password = parsed.password
    ? decodeURIComponent(parsed.password)
    : undefined;

  const username = parsed.username
    ? decodeURIComponent(parsed.username)
    : undefined;

  logger.info({ host, port, isTls }, "Connecting to Redis");

  client = new IORedis({
    host,
    port,
    ...(password ? { password } : {}),
    ...(username && username !== "default" ? { username } : {}),
    ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    lazyConnect: false,

    retryStrategy(times: number) {
      if (times > 10) {
        logger.error("Redis max retries reached");
        return null;
      }
      const delay = Math.min(times * 300, 5000);
      logger.warn({ times, delay }, "Redis reconnecting");
      return delay;
    },

    reconnectOnError(err: Error) {
      if (
        ["READONLY", "ECONNRESET", "ETIMEDOUT"].some((e) =>
          err.message.includes(e),
        )
      ) {
        return 2;
      }
      return false;
    },
  });

  client.on("connect", () => logger.info("Redis connected"));
  client.on("ready", () => logger.info("Redis ready"));
  client.on("error", (err: Error) => logger.error({ err }, "Redis error"));
  client.on("close", () => logger.warn("Redis connection closed"));
  client.on("reconnecting", () => logger.info("Redis reconnecting..."));

  return client;
}

export async function ensureRedisConnected(): Promise<IORedis> {
  const redis = getRedis();

  if (redis.status === "ready") return redis;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Redis connect timeout")),
      10_000,
    );

    redis.once("ready", () => {
      clearTimeout(timeout);
      resolve();
    });

    redis.once("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return redis;
}

// 🔑 Keys
export const ROOMS_GEO_KEY = "rooms:geo";
export const ROOMS_EXPIRY_KEY = "rooms:expiry";
export const ROOM_KEY = (id: string) => `room:${id}`;
export const MESSAGES_KEY = (roomId: string) => `room:${roomId}:messages`;
