import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClientType } from '@redis/client';
import { createClient } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit {
  private client: RedisClientType;
  private readonly logger = new Logger(RedisService.name);

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    const host = this.configService.get<string>('REDIS_HOST');
    const port = this.configService.get<string>('REDIS_PORT');
    // Optional logical database (0-15, validated at boot). Unset is Redis's own
    // default, 0. A disposable test stack sets it so its cache and OTP keys can
    // never mix with the shared development instance's (docs/MONTHLY-PRICING.md §10).
    const db = this.configService.get<number | string>('REDIS_DB');
    const path = db === undefined || db === '' ? '' : `/${Number(db)}`;
    this.client = createClient({
      url: `redis://${host}:${port}${path}`,
    });
    // node-redis types the 'error' listener argument as `any`, so `err.message`
    // is an unchecked member access -- and on a non-Error emission (the client
    // can emit a plain object on some socket failures) it would silently log
    // `undefined`, hiding the actual fault. Narrow first and fall back to a
    // string form of whatever was emitted.
    this.client.on('error', (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`Redis client error: ${detail}`);
    });
    await this.client.connect();
  }

  async set(key: string, value: string, ttl: number) {
    await this.client.set(key, value, {
      EX: ttl,
    });
  }

  async get(key: string) {
    return this.client.get(key);
  }

  async del(key: string) {
    return this.client.del(key);
  }

  /**
   * CAUTION: sets NO expiry. A counter created with this lives until something
   * deletes it, which is almost never what a caller wants — use
   * `incrWithExpiry` for anything windowed.
   */
  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  /**
   * `INCR` a counter that is guaranteed to expire, and report how long the
   * current window has left.
   *
   * WHY THIS EXISTS. `incr` above sets no TTL, so a rate-limit counter built on
   * it never resets: the first client to trip a limit is blocked for ever, and
   * the key leaks. That is not a hypothetical — it is the only counter
   * primitive this service had.
   *
   * THE WINDOW IS FIXED, NOT SLIDING. The TTL is stamped on the FIRST increment
   * and never pushed forward, so a client that keeps retrying is still released
   * when the window ends. Re-arming the expiry on every call would turn a
   * bounded penalty into an unbounded one for whoever retries hardest —
   * typically a legitimate client with a retry loop, not an attacker.
   *
   * NOT ONE ROUND TRIP, AND THAT IS FINE. `INCR` and `EXPIRE` are separate
   * commands, so a crash in between could leave a counter with no TTL; the
   * `TTL < 0` repair below closes that window on the very next call rather than
   * leaving a permanently-blocking key behind. A MULTI would not remove the
   * need for the repair (an existing TTL-less key predates the MULTI), and Lua
   * would mean shipping a script for a counter on a low-traffic endpoint.
   *
   * @returns `count` after the increment, and `ttlSeconds` remaining in the
   *   window — which callers surface as `retryAfterSeconds`.
   */
  async incrWithExpiry(
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number }> {
    const count = await this.client.incr(key);

    if (count === 1) {
      await this.client.expire(key, ttlSeconds);
      return { count, ttlSeconds };
    }

    const remaining = await this.client.ttl(key);
    // -1 = key exists with no expiry, -2 = key vanished between the two calls.
    if (remaining < 0) {
      await this.client.expire(key, ttlSeconds);
      return { count, ttlSeconds };
    }

    return { count, ttlSeconds: remaining };
  }
}
