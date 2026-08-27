import { selectOrigin, assertOrigins, cacheHeaders } from "./router.js";

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const origins = {
      legacy: env.LEGACY_ORIGIN,
      web: env.WEB_ORIGIN,
      realtime: env.REALTIME_ORIGIN,
      spa: env.SPA_ORIGIN,
    };
    const mode = env.ROUTING_MODE || "legacy";
    assertOrigins(incoming.host, origins, mode);

    const selected = selectOrigin(incoming.pathname, mode, origins);
    const upstream = new URL(selected);
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;

    const headers = new Headers(request.headers);
    // Preserve the browser-visible host/protocol for same-origin cookies,
    // WebAuthn, CORS, logs and generated redirects.
    headers.set("X-Forwarded-Host", incoming.host);
    headers.set("X-Forwarded-Proto", incoming.protocol.replace(":", ""));
    if (env.ORIGIN_SECRET) headers.set("X-AINO-Origin-Secret", env.ORIGIN_SECRET);

    const response = await fetch(new Request(upstream, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    }));

    // API/WS/upload responses pass through untouched. WebSocket upgrades keep
    // their response.webSocket object when returned directly.
    if (selected !== origins.spa) return response;

    // R2 static origin: SPA fallback on object 404, preserving the requested URL
    // in the browser while serving index.html.
    let finalResponse = response;
    if (response.status === 404 && request.method === "GET") {
      const fallback = new URL(origins.spa);
      fallback.pathname = "/index.html";
      finalResponse = await fetch(fallback.toString(), { redirect: "manual" });
    }

    const outHeaders = new Headers(finalResponse.headers);
    outHeaders.set("Cache-Control", cacheHeaders(incoming.pathname));
    outHeaders.set("X-Content-Type-Options", "nosniff");
    return new Response(finalResponse.body, {
      status: finalResponse.status,
      statusText: finalResponse.statusText,
      headers: outHeaders,
    });
  },
};