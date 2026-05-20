import { NextResponse } from 'next/server';
import { AutonomousController } from '@/lib/autonomous-controller';

export const dynamic = 'force-dynamic';

/**
 * GET /api/automation/cron-hourly
 *
 * Lightweight hourly cycle: lead ingestion + affiliate validation.
 * Runs every hour via Vercel cron. Auth: Bearer CRON_SECRET.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  const expectedKey = process.env.CRON_SECRET;
  if (!expectedKey || authHeader !== `Bearer ${expectedKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const controller = new AutonomousController();
  await controller.runHourlyCycle();

  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
}
