import { assert } from "chai";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import IORedis from "ioredis";
import { createClient } from "redis";
import { RedisLockCoordinator } from "./redis-lock-coordinator";

// Each test uses a unique key so they never collide on the shared instance.
let keyCounter = 0;
const nextKey = () => `task:fire-${Date.now()}-${keyCounter++}`;

interface ClientUnderTest {
  name: string;
  connect(url: string): Promise<{ client: unknown; close(): Promise<void> }>;
}

const clients: ClientUnderTest[] = [
  {
    name: "ioredis",
    async connect(url) {
      const client = new IORedis(url);
      return { client, close: async () => { client.disconnect(); } };
    },
  },
  {
    name: "node-redis",
    async connect(url) {
      const client = createClient({ url });
      await client.connect();
      return { client, close: async () => { await client.quit(); } };
    },
  },
];

describe("RedisLockCoordinator (integration, real Redis)", function () {
  let container: StartedRedisContainer;
  let url: string;

  beforeAll(async function () {
    container = await new RedisContainer().start();
    url = container.getConnectionUrl();
  });

  afterAll(async function () {
    await container?.stop();
  });

  for (const variant of clients) {
    describe(`with ${variant.name}`, function () {
      let conn: { client: unknown; close(): Promise<void> };
      let coordinator: RedisLockCoordinator;

      beforeAll(async function () {
        conn = await variant.connect(url);
        coordinator = new RedisLockCoordinator(conn.client);
      });

      afterAll(async function () {
        await conn?.close();
      });

      it("elects exactly one winner when two instances race the same key", async function () {
        const a = new RedisLockCoordinator(conn.client);
        const b = new RedisLockCoordinator(conn.client);
        const key = nextKey();

        const [ra, rb] = await Promise.all([
          a.shouldRun(key, 30000),
          b.shouldRun(key, 30000),
        ]);

        assert.deepEqual([ra, rb].filter(Boolean).length, 1, "exactly one winner");
      });

      it("the loser gets false, and the next fire wins after onComplete", async function () {
        const winner = new RedisLockCoordinator(conn.client);
        const loser = new RedisLockCoordinator(conn.client);
        const key = nextKey();

        assert.isTrue(await winner.shouldRun(key, 30000));
        assert.isFalse(await loser.shouldRun(key, 30000));

        await winner.onComplete(key);

        const next = new RedisLockCoordinator(conn.client);
        assert.isTrue(await next.shouldRun(key, 30000));
      });

      it("onComplete with a stale token does not release another instance's lock", async function () {
        const key = nextKey();
        const a = new RedisLockCoordinator(conn.client);

        // a wins a short lease, then it expires.
        assert.isTrue(await a.shouldRun(key, 150));
        await new Promise((r) => setTimeout(r, 300));

        // b re-acquires the now-free key with its own token.
        const b = new RedisLockCoordinator(conn.client);
        assert.isTrue(await b.shouldRun(key, 30000));

        // a (still holding its old token) tries to release: must be a no-op.
        await a.onComplete(key);

        // b's lock survives, so a third instance still loses.
        const c = new RedisLockCoordinator(conn.client);
        assert.isFalse(await c.shouldRun(key, 30000));
      });

      it("the lock expires after its TTL so a crashed holder does not block forever", async function () {
        const key = nextKey();
        const crashed = new RedisLockCoordinator(conn.client);

        assert.isTrue(await crashed.shouldRun(key, 200));
        // crashed never calls onComplete.
        await new Promise((r) => setTimeout(r, 400));

        const next = new RedisLockCoordinator(conn.client);
        assert.isTrue(await next.shouldRun(key, 30000));
      });

      it("healthCheck reports a small drift against the real server clock", async function () {
        const result = await coordinator.healthCheck();
        assert.isTrue(result.ok, `drift was ${result.driftMs}ms`);
      });
    });
  }
});
