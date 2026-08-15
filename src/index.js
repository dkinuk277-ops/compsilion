export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Temporary health-check route to confirm the D1 binding is live.
    // Will be replaced by the real subscribe/unsubscribe/admin/send routes.
    if (url.pathname === "/api/db-check") {
      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();
        return new Response(JSON.stringify({ status: "connected", result }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Everything else (all existing pages) is served exactly as before.
    return env.ASSETS.fetch(request);
  },
};
