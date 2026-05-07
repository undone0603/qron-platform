import { NextResponse } from 'next/server';
import { AutonomousController } from '@/lib/autonomous-controller';

export const dynamic = 'force-dynamic';

/**
 * GET /api/automation/cron-heal
 *
 * Periodic self-heal cycle: detects and recovers stuck workflows every 6 hours.
 * Auth: Bearer CRON_SECRET.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  const expectedKey = process.env.CRON_SECRET;
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const controller = new AutonomousController();
  await controller.runSelfHeal(360, 2); // 6h window, trigger after 2 failures

  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
