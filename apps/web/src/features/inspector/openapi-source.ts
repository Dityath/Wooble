import { parse as parseYaml } from "yaml";

export type Operation = {
  id: string;
  sourcePath?: string;
  sourceMethod?: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  parameters?: string[];
  responses?: { status: string; description: string }[];
};
export const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export function parseOpenApi(value: string): { title: string; version: string; operations: Operation[] } | null {
  try {
    const data = (value.trim().startsWith("{") ? JSON.parse(value) : parseYaml(value)) as Record<string, unknown>;
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.openapi !== "string" ||
      typeof data.paths !== "object" ||
      !data.paths
    )
      return null;
    const info = data.info as Record<string, unknown> | undefined;
    const operations: Operation[] = [];
    for (const [path, pathItem] of Object.entries(data.paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.includes(method.toUpperCase()) || !operation || typeof operation !== "object") continue;
        operations.push({
          id: crypto.randomUUID(),
          path,
          sourcePath: path,
          sourceMethod: method,
          method: method.toUpperCase(),
          summary: String((operation as Record<string, unknown>).summary ?? ""),
          description: String((operation as Record<string, unknown>).description ?? ""),
          parameters: Array.isArray((operation as Record<string, unknown>).parameters)
            ? ((operation as Record<string, unknown>).parameters as Record<string, unknown>[]).map(
                (parameter) => `${parameter.name ?? "Parameter"} · ${parameter.in ?? "query"}`,
              )
            : [],
          responses: Object.entries(
            ((operation as Record<string, unknown>).responses ?? {}) as Record<string, { description?: string }>,
          ).map(([status, response]) => ({ status, description: response?.description ?? "" })),
        });
      }
    }
    return {
      title: typeof info?.title === "string" ? info.title : "API",
      version: typeof info?.version === "string" ? info.version : "1.0.0",
      operations,
    };
  } catch {
    return null;
  }
}
export function generateOpenApi(title: string, version: string, operations: Operation[], source: string) {
  let base: Record<string, unknown> = {};
  try {
    const parsed = source.trim().startsWith("{") ? JSON.parse(source) : parseYaml(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    /* A new visual contract starts with an empty document. */
  }
  const oldPaths =
    base.paths && typeof base.paths === "object" ? (base.paths as Record<string, Record<string, unknown>>) : {};
  const paths = structuredClone(oldPaths);
  // Keep retained keys in place, but remove deleted or moved form operations first.
  // Read originals from oldPaths so moves and swaps cannot overwrite their source.
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of Object.keys(pathItem)) {
      if (
        methods.includes(method.toUpperCase()) &&
        !operations.some(
          (operation) =>
            operation.sourcePath === path &&
            operation.sourceMethod === method &&
            operation.path.trim() &&
            (operation.path.startsWith("/") ? operation.path : `/${operation.path}`) === path &&
            operation.method.toLowerCase() === method,
        )
      ) {
        delete pathItem[method];
      }
    }
  }
  for (const operation of operations) {
    if (!operation.path.trim()) continue;
    const path = operation.path.startsWith("/") ? operation.path : `/${operation.path}`;
    paths[path] ??= {};
    const original =
      operation.sourcePath !== undefined && operation.sourceMethod !== undefined
        ? oldPaths[operation.sourcePath]?.[operation.sourceMethod]
        : undefined;
    paths[path][operation.method.toLowerCase()] = {
      ...(original && typeof original === "object"
        ? original
        : { responses: { "200": { description: "Successful response" } } }),
      summary: operation.summary,
    };
  }
  for (const [path, pathItem] of Object.entries(paths)) {
    if (pathItem && typeof pathItem === "object" && Object.keys(pathItem).length === 0) delete paths[path];
  }
  return JSON.stringify(
    {
      ...base,
      openapi: base.openapi ?? "3.1.0",
      info: {
        ...(base.info && typeof base.info === "object" ? base.info : {}),
        title: title || "API",
        version: version || "1.0.0",
      },
      paths,
    },
    null,
    2,
  );
}
