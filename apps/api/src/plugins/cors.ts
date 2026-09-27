import { Elysia } from "elysia";
import { allowedWebOrigins } from "../lib/web-origins";

const allowedOrigins = new Set(allowedWebOrigins);

export function corsPlugin() {
  return new Elysia({ name: "wooble-cors" }).onRequest((context) => {
    const origin = context.request.headers.get("origin");
    if (!origin || !allowedOrigins.has(origin)) return;
    context.set.headers["access-control-allow-origin"] = origin;
    context.set.headers["access-control-allow-credentials"] = "true";
    if (context.request.method !== "OPTIONS") {
      context.set.headers.vary = "Origin";
      return;
    }
    const requestMethod = context.request.headers.get("access-control-request-method");
    if (!requestMethod) return;
    context.set.headers.vary = "Origin, Access-Control-Request-Headers";
    context.set.headers["access-control-allow-methods"] = "GET,HEAD,PUT,PATCH,POST,DELETE";
    const requestHeaders = context.request.headers.get("access-control-request-headers");
    if (requestHeaders) context.set.headers["access-control-allow-headers"] = requestHeaders;
    return new Response(null, {
      status: 204,
      headers: context.set.headers as Record<string, string>,
    });
  });
}
