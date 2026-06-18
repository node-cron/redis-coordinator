/**
 * Minimal adapter over the two Redis clients this package supports, so the
 * coordinator can stay client-agnostic and the client itself is injected (no
 * runtime dependency). Only three operations are abstracted: an atomic
 * `SET NX PX`, a Lua `eval` for the compare-and-delete, and `TIME` for clock
 * skew detection.
 *
 * Supported clients:
 * - ioredis (`new Redis(...)`)
 * - node-redis v4 (`createClient(...)`)
 */
export interface RedisAdapter {
  /**
   * Atomic `SET key value NX PX ttlMs`. Returns `true` when the key was set
   * (lock acquired), `false` when it already existed (another holder).
   */
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Runs a Lua script against a single key. Returns the raw reply. */
  evalCompareAndDelete(script: string, key: string, arg: string): Promise<unknown>;
  /** Redis server time in milliseconds (from the `TIME` command). */
  serverTimeMs(): Promise<number>;
}

export type ClientType = "auto" | "ioredis" | "node-redis";

// node-redis v4 exposes an `isOpen` boolean getter; ioredis exposes a `status`
// string. Either is a reliable, side-effect-free way to tell them apart.
function detectClientType(client: any): "ioredis" | "node-redis" {
  if (typeof client?.isOpen === "boolean") return "node-redis";
  if (typeof client?.status === "string") return "ioredis";
  throw new Error(
    "@node-cron/redis-coordinator: could not detect the Redis client. " +
      "Pass a connected ioredis or node-redis v4 client, or set the " +
      "`clientType` option explicitly ('ioredis' | 'node-redis')."
  );
}

// Parses a Redis `TIME` reply ([unixSeconds, microseconds], as strings) into ms.
function timeReplyToMs(reply: unknown): number {
  if (Array.isArray(reply) && reply.length >= 2) {
    const seconds = Number(reply[0]);
    const micros = Number(reply[1]);
    return seconds * 1000 + Math.floor(micros / 1000);
  }
  // node-redis v4 may parse TIME into a Date depending on version/config.
  if (reply instanceof Date) return reply.getTime();
  throw new Error(
    "@node-cron/redis-coordinator: unexpected reply from Redis TIME command."
  );
}

function ioredisAdapter(client: any): RedisAdapter {
  return {
    async setNxPx(key, value, ttlMs) {
      const res = await client.set(key, value, "PX", ttlMs, "NX");
      return res === "OK";
    },
    evalCompareAndDelete(script, key, arg) {
      return client.eval(script, 1, key, arg);
    },
    async serverTimeMs() {
      // ioredis exposes the raw command via `call`.
      const reply = await client.call("TIME");
      return timeReplyToMs(reply);
    },
  };
}

function nodeRedisAdapter(client: any): RedisAdapter {
  return {
    async setNxPx(key, value, ttlMs) {
      const res = await client.set(key, value, { NX: true, PX: ttlMs });
      return res === "OK";
    },
    evalCompareAndDelete(script, key, arg) {
      return client.eval(script, { keys: [key], arguments: [arg] });
    },
    async serverTimeMs() {
      // node-redis v4: `sendCommand` returns the raw reply array.
      const reply = await client.sendCommand(["TIME"]);
      return timeReplyToMs(reply);
    },
  };
}

/** Builds the right adapter for the given client, detecting it when needed. */
export function createAdapter(client: unknown, clientType: ClientType = "auto"): RedisAdapter {
  if (client == null || typeof client !== "object") {
    throw new Error(
      "@node-cron/redis-coordinator: a connected Redis client is required."
    );
  }
  const type = clientType === "auto" ? detectClientType(client) : clientType;
  return type === "ioredis"
    ? ioredisAdapter(client)
    : nodeRedisAdapter(client);
}
