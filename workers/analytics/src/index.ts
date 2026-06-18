export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const MAX_RETRIES = 3;

async function retryFetch(
  input: string,
  init: RequestInit,
  retries = MAX_RETRIES
): Promise<Response> {
  let delay = 500;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(input, init);
    if (res.ok) return res;
    if (attempt === retries) return res;
    // Exponential backoff with jitter
    await new Promise((r) => setTimeout(r, delay + Math.random() * 200));
    delay *= 2;
  }
  throw new Error('retryFetch: unreachable');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check — used by CI and the app's /api/health probe
    if (url.pathname === '/health' || url.pathname === '/api/health') {
      const ok = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
      return new Response(
        JSON.stringify({
          status: ok ? 'healthy' : 'misconfigured',
          worker: 'analytics',
          timestamp: new Date().toISOString(),
        }),
        {
          status: ok ? 200 : 503,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    if (request.method !== 'POST' || url.pathname !== '/api/analytics/track') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const payload = await request.json();

      // Offload DB write to background — client gets an immediate <50ms response
      ctx.waitUntil(this.logEvent(payload, env));

      return new Response(JSON.stringify({ success: true, queued: true }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async logEvent(payload: Record<string, unknown>, env: Env) {
    const { eventName, properties, userId, sessionId } = payload as {
      eventName?: string;
      properties?: Record<string, unknown>;
      userId?: string;
      sessionId?: string;
    };

    try {
      await retryFetch(
        `${env.SUPABASE_URL}/rest/v1/audit_log`,
        {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            action: eventName || 'page_view',
            actor: userId || sessionId || 'anonymous',
            metadata: properties || {},
            target: 'analytics_engine',
            created_at: new Date().toISOString(),
          }),
        },
        MAX_RETRIES
      );
    } catch (err) {
      console.error('[analytics] logEvent failed after retries:', err);
    }
  },
};
