# @node-cron/redis-coordinator

A Redis-backed `RunCoordinator` for [node-cron](https://github.com/merencia/node-cron).
It gives `distributed: true` tasks **per-fire, highly-available** coordination
across a fleet: every instance runs the same schedule, and for each fire exactly
one instance wins a Redis lock and runs the task. It survives the loss of any
single node.

## The problem it solves

Run three replicas with the same cron and the task fires three times:

```js
// On every replica:
cron.schedule('0 3 * * *', runNightlyBackup, { name: 'nightly-backup', distributed: true });
```

Without coordination the backup runs 3x. With a coordinator, it runs **once per
fire**, and if the instance that would have run it is down, another one picks it
up.

node-cron ships a built-in default (`EnvVarRunCoordinator`) that elects a single
**designated** runner via an env var. That is simple and dependency-free, but it
is not HA: if the designated instance is down, nothing runs. This package is the
HA upgrade: any instance can run, only one wins each fire, and there is no single
point of failure.

| | Built-in env-var default | This package (Redis) |
| --- | --- | --- |
| Coordination | one designated runner | per-fire election |
| If the runner dies | nothing runs | another instance wins |
| Dependency | none | a Redis you already run |
| Use when | simple, one box is "primary" | true HA across a fleet |

## You bring the Redis client. This package does not.

Read this first, because it is the single most important thing about how this
package works.

**This package does not install, bundle, or depend on a Redis client at
runtime.** It has zero runtime dependencies. The only thing it imports at runtime
is Node's built-in `crypto`.

Instead, **you pass in a Redis client you already created and connected**, and
the coordinator uses it:

```js
const redis = createClient(); // YOUR client, YOUR connection, YOUR config
await redis.connect();

new RedisLockCoordinator(redis); // you hand it in; the package just uses it
```

Why it is designed this way:

- **You already have a Redis client.** If you are running a fleet that needs HA
  cron coordination, your app almost certainly already talks to Redis somewhere
  (cache, sessions, queues). You reuse that exact client and its connection. The
  coordinator is not a second connection or a second config to manage.
- **You stay in control.** TLS, Sentinel, Cluster, auth, retry strategy,
  connection pooling: all of that is on your client. This package never reaches
  around it, so it can never disagree with your Redis setup.
- **No version lock-in.** Because the client is injected and never bundled, this
  package does not pin you to a client version or pull a duplicate copy into your
  `node_modules`.

It works with either of the two common Node Redis clients, **whichever one you
already use**:

- [`ioredis`](https://github.com/redis/ioredis)
- [`node-redis` v4](https://github.com/redis/node-redis) (the package named `redis`)

The coordinator auto-detects which one you passed. You do not configure that.

## Install

You install this package, plus `node-cron`, plus **the Redis client you already
use** (you do not install both clients, only the one you already have):

```bash
# if your app uses node-redis (the `redis` package):
npm install @node-cron/redis-coordinator node-cron redis

# or, if your app uses ioredis:
npm install @node-cron/redis-coordinator node-cron ioredis
```

`node-cron` (>= 4.4.1, the first release with `distributedLease`) is a peer
dependency. The Redis client is **not** a
dependency of this package at all: it is something you bring. If your app already
has `redis` or `ioredis` in its `package.json`, you do not add anything new for
the client. See [the section above](#you-bring-the-redis-client-this-package-does-not).

## Usage

```js
import { createClient } from 'redis';
import cron from 'node-cron';
import { RedisLockCoordinator } from '@node-cron/redis-coordinator';

const redis = createClient();
await redis.connect();

cron.setRunCoordinator(new RedisLockCoordinator(redis));

// Deploy this on N instances: only one runs each 3am fire, and it survives the
// loss of any node.
cron.schedule('0 3 * * *', () => runNightlyBackup(), {
  name: 'nightly-backup',
  distributed: true,
  distributedLease: 5 * 60_000, // the backup can take up to ~5 minutes (see below)
});
```

### With ioredis

```js
import Redis from 'ioredis';
const redis = new Redis();
cron.setRunCoordinator(new RedisLockCoordinator(redis));
```

The client type is auto-detected. If you wrap the client and detection fails,
set it explicitly:

```js
new RedisLockCoordinator(redis, { clientType: 'ioredis' }); // or 'node-redis'
```

## Options

```ts
new RedisLockCoordinator(client, {
  keyPrefix: 'node-cron:lock:', // default; namespaces every lock key
  clientType: 'auto',           // 'auto' | 'ioredis' | 'node-redis'
  logger: console,              // sink for clock-skew warnings (needs `.warn`)
});
```

## How it works

- **`shouldRun(key, leaseMs)`** runs a single atomic `SET <prefix><key> <token> NX
  PX <leaseMs>`. `NX` means it only sets if the key is free, so exactly one racing
  instance gets `OK` (returns `true`); the others get `null` (`false`). The
  unique `token` is remembered for release.
- **`onComplete(key)`** releases the lock with an atomic Lua compare-and-delete:
  it deletes the key **only if** it still holds this instance's token. A blind
  `DEL` could wipe another instance's lock if ours had already expired and been
  re-acquired.
- Keys carry a TTL, so they expire on their own. Nothing to clean up.

If `shouldRun` rejects (for example Redis is unreachable), the error propagates.
node-cron treats that as **fail-closed**: it skips the fire rather than risk
running everywhere. This is deliberate, so a real outage stays distinguishable
from "another instance won".

## The guarantee (read this)

- **Non-concurrent across instances.** Effectively "once per fire" when the
  instance clocks are in sync.
- **Not** absolute exactly-once. A crash plus retry, or large clock skew, can run
  a fire again. For strong exactly-once semantics, **make the task idempotent**.

### `distributedLease` must be longer than the task

The lease is a safety net against a crashed holder. In normal operation node-cron
calls `onComplete` as soon as the task finishes, so the key is released
immediately. But if `distributedLease` is **shorter than the task's runtime**, the
key expires mid-run and another instance can start a concurrent run. Always set
`distributedLease` comfortably above the task's worst-case duration.

### Clock-skew detection (optional)

Coordination depends on every instance computing the **same** fire time for a
given fire (so they derive the same lock key). If clocks drift apart, instances
produce different keys and stop coordinating. `healthCheck()` compares the local
clock to the Redis server clock and warns past a threshold:

```js
const { driftMs, ok } = await coordinator.healthCheck(1000); // threshold in ms
if (!ok) {
  // alert: clocks are out of sync across the fleet (check NTP)
}
```

Cheap to call at startup or on an interval. Keep your fleet on NTP.

## Events

In a distributed task, the instance that wins emits the normal lifecycle
(`execution:started` then `execution:finished` / `execution:failed`). The others
emit `execution:skipped` with `context.reason`:

- `'not-elected'` another instance won the fire (healthy, expected).
- `'coordinator-error'` the coordinator failed (for example Redis is down) and
  node-cron skipped fail-closed. **Alert on this**: the fire may not have run
  anywhere.

## Compatibility

- Node.js >= 20.
- `node-cron` >= 4.4.1 (peer dependency).
- Redis client: `ioredis` or `node-redis` v4 (injected, auto-detected).
- Ships ESM + CJS with TypeScript types.

## License

ISC
