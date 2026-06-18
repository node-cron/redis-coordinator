# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-18

First release.

### Added
- `RedisLockCoordinator`, a Redis-backed `RunCoordinator` for node-cron that
  gives `distributed: true` tasks per-fire, highly-available coordination across
  a fleet: every instance runs the same schedule and exactly one wins the lock
  for each fire, surviving the loss of any single node.
- Atomic lock acquisition via `SET <key> <token> NX PX <leaseMs>`, and release
  via a Lua compare-and-delete so an instance only ever releases its own lock.
- Fail-closed behavior: errors from `shouldRun` propagate so node-cron skips the
  fire (`reason: 'coordinator-error'`) instead of risking a run everywhere.
- Optional `healthCheck()` that compares the local clock with the Redis server
  clock and warns when the drift would degrade coordination.
- Client-agnostic by injection: works with `ioredis` or `node-redis` v4
  (auto-detected, or set `clientType` explicitly). Zero runtime dependencies.
- Dual ESM/CJS build with bundled TypeScript declarations.

[Unreleased]: https://github.com/node-cron/redis-coordinator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/node-cron/redis-coordinator/releases/tag/v0.1.0
