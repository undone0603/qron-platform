export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    
    // Health Check Endpoint
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'Ecosystem Edge Live', node: 'Active' }), { status: 200 });
    }

    // Default Fallback
    return new Response(JSON.stringify({ error: 'Unauthorized Edge Access' }), { status: 401 });
  }
};
