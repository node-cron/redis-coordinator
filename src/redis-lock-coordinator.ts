import { randomUUID } from "node:crypto";
import type { RunCoordinator } from "node-cron";
import { createAdapter, type ClientType, type RedisAdapter } from "./redis-adapter";

// Compare-and-delete: only release the lock if WE still hold it (the stored
// token matches). A blind DEL would wipe another instance's lock if ours had
// already expired and been re-acquired. Atomic via Lua.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

/** Logger sink for diagnostics (clock skew). Defaults to `console`. */
export interface CoordinatorLogger {
  warn(message: string): void;
}

export interface RedisLockCoordinatorOptions {
  /** Key prefix applied to every lock key. Default `'node-cron:lock:'`. */
  keyPrefix?: string;
  /**
   * Which client was injected. `'auto'` (default) detects ioredis vs
   * node-redis v4; set explicitly to skip detection.
   */
  clientType?: ClientType;
  /** Sink for skew warnings. Defaults to `console`. */
  logger?: CoordinatorLogger;
}

/** Result of {@link RedisLockCoordinator.healthCheck}. */
export interface HealthCheckResult {
  /** Absolute drift between local and Redis-server clocks, in ms. */
  driftMs: number;
  /** `true` when `driftMs` is within the threshold. */
  ok: boolean;
}

/**
 * A Redis-backed {@link RunCoordinator} for node-cron. Provides per-fire,
 * highly-available coordination across a fleet: every instance runs the same
 * `distributed: true` task, and for each fire exactly one instance wins the
 * lock and runs it. Survives the loss of any single node.
 *
 * Guarantee: non-concurrent across instances (effectively once-per-fire when
 * clocks are in sync). NOT absolute exactly-once: a crash + retry, or large
 * clock skew, can run a fire again. For strong exactly-once, make the task
 * idempotent.
 *
 * @example
 * ```ts
 * import { createClient } from 'redis';
 * import cron from 'node-cron';
 * import { RedisLockCoordinator } from '@node-cron/redis-coordinator';
 *
 * const redis = createClient();
 * await redis.connect();
 * cron.setRunCoordinator(new RedisLockCoordinator(redis));
 * ```
 */
export class RedisLockCoordinator implements RunCoordinator {
  private readonly adapter: RedisAdapter;
  private readonly keyPrefix: string;
  private readonly logger: CoordinatorLogger;
  // Tokens we currently hold, keyed by the core's fire key. Used so onComplete
  // releases only our own lock.
  private readonly tokens = new Map<string, string>();

  constructor(client: unknown, options: RedisLockCoordinatorOptions = {}) {
    this.adapter = createAdapter(client, options.clientType);
    this.keyPrefix = options.keyPrefix ?? "node-cron:lock:";
    this.logger = options.logger ?? console;
  }

  /**
   * Atomically acquire the lock for this fire. Returns `true` if THIS instance
   * won (and should run), `false` if another instance already holds it.
   *
   * Rejections propagate (fail-closed): node-cron skips the fire with
   * `reason: 'coordinator-error'`. We deliberately do not swallow Redis errors,
   * so a real outage is distinguishable from "another instance won".
   */
  async shouldRun(key: string, leaseMs: number): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.adapter.setNxPx(this.keyPrefix + key, token, leaseMs);
    if (acquired) {
      this.tokens.set(key, token);
    }
    return acquired;
  }

  /**
   * Release the lock held for this fire (compare-and-delete by token). No-op if
   * we never held it (e.g. we lost the election, or it was already released).
   */
  async onComplete(key: string): Promise<void> {
    const token = this.tokens.get(key);
    if (token === undefined) return;
    this.tokens.delete(key);
    await this.adapter.evalCompareAndDelete(RELEASE_SCRIPT, this.keyPrefix + key, token);
  }

  /**
   * Compares the local clock against the Redis server clock and warns when the
   * drift exceeds `thresholdMs` (default 1000ms). The guarantee degrades with
   * skew: instances compute different fire times, produce different keys, and
   * stop coordinating. Cheap to call at startup or periodically.
   */
  async healthCheck(thresholdMs = 1000): Promise<HealthCheckResult> {
    const serverMs = await this.adapter.serverTimeMs();
    const driftMs = Math.abs(Date.now() - serverMs);
    const ok = driftMs <= thresholdMs;
    if (!ok) {
      this.logger.warn(
        `@node-cron/redis-coordinator: clock drift of ${driftMs}ms exceeds ` +
          `${thresholdMs}ms against the Redis server. Distributed coordination ` +
          `degrades when instance clocks disagree (different fire times produce ` +
          `different lock keys). Sync clocks (NTP) across the fleet.`
      );
    }
    return { driftMs, ok };
  }
}
