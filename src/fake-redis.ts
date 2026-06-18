/**
 * In-memory fake mimicking the node-redis v4 surface the adapter uses, with
 * real `SET NX PX` and Lua compare-and-delete semantics. Honours TTL against
 * the (possibly faked) system clock so expiry can be tested. Test-only.
 */
export class FakeRedis {
  // Presence of an `isOpen` boolean makes the adapter detect us as node-redis.
  isOpen = true;
  private store = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(
    key: string,
    value: string,
    opts?: { NX?: boolean; PX?: number }
  ): Promise<"OK" | null> {
    if (opts?.NX && this.live(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + (opts?.PX ?? Infinity) });
    return "OK";
  }

  async eval(
    _script: string,
    opts: { keys: string[]; arguments: string[] }
  ): Promise<number> {
    // Faithful to the package's release script: delete only on token match.
    const key = opts.keys[0];
    const token = opts.arguments[0];
    const entry = this.live(key);
    if (entry && entry.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async sendCommand(command: string[]): Promise<string[]> {
    if (command[0] === "TIME") {
      const ms = Date.now();
      return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
    }
    throw new Error(`FakeRedis: unsupported command ${command[0]}`);
  }

  /** Test helper: current stored token for a key (bypasses TTL). */
  rawValue(key: string): string | undefined {
    return this.store.get(key)?.value;
  }

  /** Test helper: forcibly seat a value (simulates another instance's lock). */
  seed(key: string, value: string, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}
