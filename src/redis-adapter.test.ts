import { assert } from "chai";
import { createAdapter } from "./redis-adapter";

// Records every call so we can assert the exact per-client signatures.
function recorder() {
  const calls: { method: string; args: any[] }[] = [];
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (method === "set") return Promise.resolve("OK");
    if (method === "call" || method === "sendCommand") return Promise.resolve(["1718600000", "500000"]);
    return Promise.resolve(1);
  };
  return { calls, record };
}

function ioredisStub() {
  const { calls, record } = recorder();
  return {
    calls,
    client: {
      status: "ready", // ioredis marker
      set: record("set"),
      eval: record("eval"),
      call: record("call"),
    },
  };
}

function nodeRedisStub() {
  const { calls, record } = recorder();
  return {
    calls,
    client: {
      isOpen: true, // node-redis v4 marker
      set: record("set"),
      eval: record("eval"),
      sendCommand: record("sendCommand"),
    },
  };
}

describe("createAdapter", function () {
  describe("client detection", function () {
    it("detects ioredis by its `status` property", async function () {
      const { client, calls } = ioredisStub();
      const adapter = createAdapter(client);

      await adapter.setNxPx("k", "tok", 30000);
      assert.deepEqual(calls[0], { method: "set", args: ["k", "tok", "PX", 30000, "NX"] });
    });

    it("detects node-redis v4 by its `isOpen` property", async function () {
      const { client, calls } = nodeRedisStub();
      const adapter = createAdapter(client);

      await adapter.setNxPx("k", "tok", 30000);
      assert.deepEqual(calls[0], { method: "set", args: ["k", "tok", { NX: true, PX: 30000 }] });
    });

    it("honours an explicit clientType override", async function () {
      // A node-redis-shaped stub forced to be treated as node-redis.
      const { client, calls } = nodeRedisStub();
      const adapter = createAdapter(client, "node-redis");
      await adapter.setNxPx("k", "tok", 1000);
      assert.equal(calls[0].method, "set");
      assert.deepEqual(calls[0].args[2], { NX: true, PX: 1000 });
    });

    it("throws when the client cannot be detected", function () {
      assert.throws(() => createAdapter({ foo: "bar" }), /could not detect/);
    });

    it("throws when no client is provided", function () {
      assert.throws(() => createAdapter(null), /connected Redis client is required/);
    });
  });

  describe("setNxPx", function () {
    it("returns true when the reply is OK (lock acquired)", async function () {
      const { client } = ioredisStub();
      const adapter = createAdapter(client);
      assert.isTrue(await adapter.setNxPx("k", "tok", 1000));
    });

    it("returns false when the reply is null (already held)", async function () {
      const client = { status: "ready", set: () => Promise.resolve(null) };
      const adapter = createAdapter(client);
      assert.isFalse(await adapter.setNxPx("k", "tok", 1000));
    });
  });

  describe("evalCompareAndDelete", function () {
    it("ioredis: passes numkeys, key, then token", async function () {
      const { client, calls } = ioredisStub();
      const adapter = createAdapter(client);
      await adapter.evalCompareAndDelete("SCRIPT", "k", "tok");
      assert.deepEqual(calls[0], { method: "eval", args: ["SCRIPT", 1, "k", "tok"] });
    });

    it("node-redis: passes a { keys, arguments } object", async function () {
      const { client, calls } = nodeRedisStub();
      const adapter = createAdapter(client);
      await adapter.evalCompareAndDelete("SCRIPT", "k", "tok");
      assert.deepEqual(calls[0], {
        method: "eval",
        args: ["SCRIPT", { keys: ["k"], arguments: ["tok"] }],
      });
    });
  });

  describe("serverTimeMs", function () {
    it("ioredis: reads TIME via `call` and converts to ms", async function () {
      const { client } = ioredisStub();
      const adapter = createAdapter(client);
      assert.equal(await adapter.serverTimeMs(), 1718600000 * 1000 + 500);
    });

    it("node-redis: reads TIME via `sendCommand` and converts to ms", async function () {
      const { client } = nodeRedisStub();
      const adapter = createAdapter(client);
      assert.equal(await adapter.serverTimeMs(), 1718600000 * 1000 + 500);
    });
  });
});
