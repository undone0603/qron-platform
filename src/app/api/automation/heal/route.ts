import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAutomation, formatErr } from '@/lib/automation';
import { resetCircuitBreaker, getAllCircuitBreakerStatuses } from '@/lib/circuit-breaker';
import { AutonomousController } from '@/lib/autonomous-controller';

export const dynamic = 'force-dynamic';

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/automation/heal
 *
 * Self-healing endpoint. Inspects automation_logs for workflows that have
 * failed ≥ threshold times in the past window, resets their circuit breakers,
 * and optionally re-triggers the autonomous controller.
 *
 * Body (JSON, all optional):
 *   windowMinutes   - lookback window for failure detection (default 60)
 *   failThreshold   - minimum failure count to flag a workflow (default 3)
 *   resetBreakers   - reset ALL open circuit breakers (default true)
 *   retriggerCycle  - re-run the full AutonomousController daily cycle (default false)
 *
 * Auth: Bearer CRON_SECRET (same key used by the cron endpoint).
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get('Authorization');
  const expectedKey = process.env.CRON_SECRET;
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine
  }

  const windowMinutes = Number(body.windowMinutes ?? 60);
  const failThreshold = Number(body.failThreshold ?? 3);
  const resetBreakers = body.resetBreakers !== false;
  const retriggerCycle = body.retriggerCycle === true;

  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  // ── 1. Find repeatedly-failing workflows ──────────────────────────────────
  const { data: failRows, error } = await admin
    .from('automation_logs')
    .select('workflow_name, error_message, created_at')
    .eq('status', 'failure')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: 'DB query failed', detail: error.message }, { status: 500 });
  }

  const failMap = new Map<string, { count: number; lastError: string }>();
  for (const row of failRows ?? []) {
    const existing = failMap.get(row.workflow_name);
    if (existing) {
      existing.count++;
    } else {
      failMap.set(row.workflow_name, {
        count: 1,
        lastError: row.error_message || '(no message)',
      });
    }
  }

  const criticalWorkflows = Array.from(failMap.entries())
    .filter(([, v]) => v.count >= failThreshold)
    .map(([name, v]) => ({ name, ...v }));

  // ── 2. Reset circuit breakers for flagged workflows ───────────────────────
  const resetResults: string[] = [];
  if (resetBreakers) {
    const allBreakers = getAllCircuitBreakerStatuses();
    for (const b of allBreakers) {
      if (b.state === 'open') {
        resetCircuitBreaker(b.name);
        resetResults.push(b.name);
      }
    }
    for (const wf of criticalWorkflows) {
      resetCircuitBreaker(wf.name);
      if (!resetResults.includes(wf.name)) resetResults.push(wf.name);
    }
  }

  // ── 3. Optionally re-trigger the business cycle ───────────────────────────
  let cycleResult: string | null = null;
  if (retriggerCycle) {
    try {
      const controller = new AutonomousController();
      await controller.runDailyCycle();
      cycleResult = 'triggered';
    } catch (err) {
      cycleResult = `failed: ${formatErr(err)}`;
    }
  }

  // ── 4. Log the heal event ─────────────────────────────────────────────────
  await logAutomation('self_heal', 'manual', 'success', {
    windowMinutes,
    failThreshold,
    criticalWorkflows,
    breakersReset: resetResults,
    cycleResult,
  });

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    analysisWindow: `${windowMinutes}m`,
    criticalWorkflows,
    breakersReset: resetResults,
    cycleResult,
  });
}
