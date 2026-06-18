import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAllCircuitBreakerStatuses } from '@/lib/circuit-breaker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEALTH_SECRET = process.env.HEALTH_SECRET;

/**
 * GET /api/health
 *
 * Returns a comprehensive health report covering:
 *  - Database connectivity (Supabase ping)
 *  - External service reachability (Cloudflare Worker, HubSpot)
 *  - Circuit breaker states
 *  - Process uptime
 *
 * Secured by an optional HEALTH_SECRET bearer token.
 * Returns 200 when healthy, 503 when any critical check fails.
 */
export async function GET(request: Request) {
  // Optional auth — if HEALTH_SECRET is set, require it
  if (HEALTH_SECRET) {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${HEALTH_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const start = Date.now();
  const checks: Record<string, unknown> = {};
  let allHealthy = true;

  // ── 1. Database ──────────────────────────────────────────────────────────
  try {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const { error } = await admin
      .from('automation_logs')
      .select('id', { count: 'exact', head: true })
      .limit(1);

    checks.database = error
      ? { status: 'unhealthy', error: error.message }
      : { status: 'healthy' };
    if (error) allHealthy = false;
  } catch (e) {
    checks.database = { status: 'unhealthy', error: String(e) };
    allHealthy = false;
  }

  // ── 2. Edge Worker ────────────────────────────────────────────────────────
  try {
    const workerUrl = process.env.QRON_WORKER_URL || 'https://qron-ai-api.undone-k.workers.dev';
    const res = await fetch(`${workerUrl}/api/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    checks.edgeWorker = res.ok
      ? { status: 'healthy', latencyMs: Date.now() - start }
      : { status: 'degraded', httpStatus: res.status };
    if (!res.ok) allHealthy = false;
  } catch (e) {
    checks.edgeWorker = { status: 'unreachable', error: String(e) };
    allHealthy = false;
  }

  // ── 3. HubSpot API ────────────────────────────────────────────────────────
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  if (hubspotToken) {
    try {
      const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
        headers: { Authorization: `Bearer ${hubspotToken}` },
        signal: AbortSignal.timeout(4_000),
      });
      checks.hubspot = res.ok
        ? { status: 'healthy' }
        : { status: 'degraded', httpStatus: res.status };
    } catch (e) {
      checks.hubspot = { status: 'unreachable', error: String(e) };
    }
  } else {
    checks.hubspot = { status: 'skipped', reason: 'HUBSPOT_ACCESS_TOKEN not set' };
  }

  // ── 4. Circuit Breakers ───────────────────────────────────────────────────
  const breakers = getAllCircuitBreakerStatuses();
  const openBreakers = breakers.filter((b) => b.state === 'open');
  checks.circuitBreakers = {
    total: breakers.length,
    open: openBreakers.length,
    details: breakers,
  };
  if (openBreakers.length > 0) allHealthy = false;

  // ── 5. Recent Failures (last 1h) ──────────────────────────────────────────
  try {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count: failCount } = await admin
      .from('automation_logs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'failure')
      .gte('created_at', since);

    checks.recentFailures = { last1h: failCount ?? 0 };
    if ((failCount ?? 0) > 10) allHealthy = false;
  } catch {
    checks.recentFailures = { status: 'query_failed' };
  }

  const status = allHealthy ? 'healthy' : 'degraded';
  const httpStatus = allHealthy ? 200 : 503;

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime?.() ?? 0),
      latencyMs: Date.now() - start,
      checks,
    },
    { status: httpStatus }
  );
}
