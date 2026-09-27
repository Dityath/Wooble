const connectionErrorCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "08001",
  "08006",
  "57P01",
  "57P03",
]);

export type ReplyContext = { set: { status?: number | string; headers: Record<string, unknown> } };

export function isDatabaseConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.code === "string" && connectionErrorCodes.has(candidate.code)) return true;
  if (Array.isArray(candidate.errors) && candidate.errors.some(isDatabaseConnectionError)) return true;
  return isDatabaseConnectionError(candidate.cause);
}

export function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return postgresErrorCode(candidate.cause);
}

export function notFound(reply: ReplyContext, message = "Resource not found") {
  reply.set.status = 404;
  return { error: "not_found", message };
}

export function badRequest(reply: ReplyContext, message: string) {
  reply.set.status = 400;
  return { error: "bad_request", message };
}
