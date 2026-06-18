import { assert } from "chai";
import { RedisLockCoordinator } from "./redis-lock-coordinator";
import { FakeRedis } from "./fake-redis";

const PREFIX = "node-cron:lock:";
const KEY = "backup:2026-06-17T03:00:00.000Z";

describe("RedisLockCoordinator", function () {
  describe("shouldRun", function () {
    it("returns true and acquires the lock when the key is free", async function () {
      const redis = new FakeRedis();
      const coordinator = new RedisLockCoordinator(redis);

      assert.isTrue(await coordinator.shouldRun(KEY, 30000));
      assert.isDefined(redis.rawValue(PREFIX + KEY));
    });

    it("returns false when another instance already holds the lock", async function () {
      const redis = new FakeRedis();
      const winner = new RedisLockCoordinator(redis);
      const loser = new RedisLockCoordinator(redis);

      assert.isTrue(await winner.shouldRun(KEY, 30000));
      assert.isFalse(await loser.shouldRun(KEY, 30000));
    });

    it("elects exactly one winner when two instances race the same key", async function () {
      const redis = new FakeRedis();
      const a = new RedisLockCoordinator(redis);
      const b = new RedisLockCoordinator(redis);

      const results = await Promise.all([
        a.shouldRun(KEY, 30000),
        b.shouldRun(KEY, 30000),
      ]);

      assert.deepEqual(results.filter(Boolean).length, 1, "exactly one true");
    });

    it("applies the configured key prefix", async function () {
      const redis = new FakeRedis();
      const coordinator = new RedisLockCoordinator(redis, { keyPrefix: "myapp:" });

      await coordinator.shouldRun(KEY, 30000);
      assert.isDefined(redis.rawValue("myapp:" + KEY));
      assert.isUndefined(redis.rawValue(PREFIX + KEY));
    });

    it("propagates client errors (fail-closed) instead of swallowing them", async function () {
      const redis = new FakeRedis();
      redis.set = () => Promise.reject(new Error("redis down"));
      const coordinator = new RedisLockCoordinator(redis);

      let error: Error | undefined;
      try {
        await coordinator.shouldRun(KEY, 30000);
      } catch (err) {
        error = err as Error;
      }
      assert.instanceOf(error, Error);
      assert.match(error!.message, /redis down/);
    });
  });

  describe("onComplete", function () {
    it("releases the lock we hold so the next fire can win", async function () {
      const redis = new FakeRedis();
      const winner = new RedisLockCoordinator(redis);
      const next = new RedisLockCoordinator(redis);

      assert.isTrue(await winner.shouldRun(KEY, 30000));
      await winner.onComplete(KEY);

      assert.isUndefined(redis.rawValue(PREFIX + KEY));
      assert.isTrue(await next.shouldRun(KEY, 30000));
    });

    it("is a no-op for an instance that never held the lock", async function () {
      const redis = new FakeRedis();
      const winner = new RedisLockCoordinator(redis);
      const other = new RedisLockCoordinator(redis);

      assert.isTrue(await winner.shouldRun(KEY, 30000));
      const heldToken = redis.rawValue(PREFIX + KEY);

      await other.onComplete(KEY); // other never won; must not touch the lock

      assert.equal(redis.rawValue(PREFIX + KEY), heldToken);
    });

    it("never deletes a lock held by someone else (token mismatch)", async function () {
      const redis = new FakeRedis();
      const coordinator = new RedisLockCoordinator(redis);

      assert.isTrue(await coordinator.shouldRun(KEY, 30000));
      // Simulate our lease expiring and another instance re-acquiring the key.
      redis.seed(PREFIX + KEY, "another-instance-token", 30000);

      await coordinator.onComplete(KEY);

      assert.equal(redis.rawValue(PREFIX + KEY), "another-instance-token");
    });

    it("is a no-op when called twice (lock already released)", async function () {
      const redis = new FakeRedis();
      const coordinator = new RedisLockCoordinator(redis);

      await coordinator.shouldRun(KEY, 30000);
      await coordinator.onComplete(KEY);
      await coordinator.onComplete(KEY); // must not throw
      assert.isUndefined(redis.rawValue(PREFIX + KEY));
    });
  });

  describe("expiration (TTL safety net)", function () {
    it("lets another instance win after the lease expires", async function () {
      vi.useFakeTimers();
      try {
        const redis = new FakeRedis();
        const crashed = new RedisLockCoordinator(redis);
        const next = new RedisLockCoordinator(redis);

        assert.isTrue(await crashed.shouldRun(KEY, 30000));
        // crashed instance never calls onComplete; the lease must expire.
        assert.isFalse(await next.shouldRun(KEY, 30000));

        await vi.advanceTimersByTimeAsync(30001);

        assert.isTrue(await next.shouldRun(KEY, 30000));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("healthCheck", function () {
    it("reports ok when the local and server clocks agree", async function () {
      const redis = new FakeRedis();
      const coordinator = new RedisLockCoordinator(redis);

      const result = await coordinator.healthCheck();
      assert.isTrue(result.ok);
      assert.isAtMost(result.driftMs, 1000);
    });

    it("warns and reports not-ok when drift exceeds the threshold", async function () {
      const redis = new FakeRedis();
      // Server clock far ahead of local.
      redis.sendCommand = async () => [String(Math.floor(Date.now() / 1000) + 60), "0"];
      const warnings: string[] = [];
      const coordinator = new RedisLockCoordinator(redis, {
        logger: { warn: (m) => warnings.push(m) },
      });

      const result = await coordinator.healthCheck(1000);

      assert.isFalse(result.ok);
      assert.isAbove(result.driftMs, 1000);
      assert.lengthOf(warnings, 1);
      assert.match(warnings[0], /clock drift/);
    });
  });
});
