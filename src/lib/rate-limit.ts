/**
 * Sliding-window in-memory rate limiter with a DB fallback.
 *
 * Two tiers:
 *  1. In-process LRU cache — O(1) for the common path; zero DB writes.
 *  2. Supabase fallback   — fire-and-forget persistence for observability.
 *
 * The in-memory tier is the authoritative gate. The DB tier is best-effort
 * and fails open to maximise availability.
 */

import { createClient } from '@/utils/supabase/server';

interface WindowEntry {
  timestamps: number[];
  expiresAt: number;
}

// Bounded map — prevents OOM on long-running instances.
const MAX_ENTRIES = 10_000;
const store = new Map<string, WindowEntry>();

function evict() {
  if (store.size >= MAX_ENTRIES) {
    const toDelete = Math.ceil(MAX_ENTRIES * 0.1);
    let deleted = 0;
    for (const key of store.keys()) {
      store.delete(key);
      if (++deleted >= toDelete) break;
    }
  }
}

/**
 * Synchronous in-memory sliding-window check.
 * Safe to call from edge runtimes and Workers — no I/O.
 */
export function checkRateLimitSync(
  identifier: string,
  limit = 60,
  windowMs = 60_000
): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowStart = now - windowMs;

  let entry = store.get(identifier);
  if (!entry || entry.expiresAt < now) {
    evict();
    entry = { timestamps: [], expiresAt: now + windowMs };
    store.set(identifier, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  const remaining = limit - entry.timestamps.length;

  if (remaining <= 0) {
    return { ok: false, remaining: 0, resetAt: entry.timestamps[0] + windowMs };
  }

  entry.timestamps.push(now);
  return { ok: true, remaining: remaining - 1, resetAt: now + windowMs };
}

/**
 * Async wrapper — uses in-memory gate and best-effort Supabase persistence.
 */
export async function checkRateLimit(
  identifier: string,
  limit = 60,
  windowMinutes = 1
): Promise<{ ok: boolean; remaining: number }> {
  const result = checkRateLimitSync(identifier, limit, windowMinutes * 60_000);

  if (result.ok) {
    persistHit(identifier).catch(() => {});
  }

  return { ok: result.ok, remaining: result.remaining };
}

async function persistHit(identifier: string) {
  const supabase = await createClient();
  await supabase.from('automation_logs').insert({
    workflow_name: 'api_rate_limit',
    trigger_type: 'event',
    status: 'success',
    payload: identifier,
  });
}
