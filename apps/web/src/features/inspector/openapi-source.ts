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
    if (!data || typeof data !== "object" || typeof data.openapi !== "string" || !isPathItem(data.paths)) return null;
    const info = data.info as Record<string, unknown> | undefined;
    const operations: Operation[] = [];
    for (const [path, pathItem] of Object.entries(data.paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.includes(method.toUpperCase()) || !isPathItem(operation)) continue;
        operations.push({
          id: crypto.randomUUID(),
          path,
          sourcePath: path,
          sourceMethod: method,
          method: method.toUpperCase(),
          summary: String((operation as Record<string, unknown>).summary ?? ""),
          description: String((operation as Record<string, unknown>).description ?? ""),
          parameters: Array.isArray((operation as Record<string, unknown>).parameters)
            ? ((operation as Record<string, unknown>).parameters as unknown[])
                .filter(isPathItem)
                .map((parameter) => `${parameter.name ?? "Parameter"} · ${parameter.in ?? "query"}`)
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
export class OpenApiEditError extends Error {}

function isPathItem(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function destinationPath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

export function generateOpenApi(title: string, version: string, operations: Operation[], source: string) {
  let base: Record<string, unknown> = {};
  try {
    const parsed = source.trim().startsWith("{") ? JSON.parse(source) : parseYaml(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    /* A new visual contract starts with an empty document. */
  }
  const oldPaths = isPathItem(base.paths) ? base.paths : {};
  const destinations = new Set<string>();
  for (const operation of operations) {
    if (!operation.path.trim()) continue;
    const path = destinationPath(operation.path);
    const destination = `${operation.method.toUpperCase()} ${path}`;
    if (destinations.has(destination)) {
      throw new OpenApiEditError(`Two operations use ${destination}. Change one before saving.`);
    }
    destinations.add(destination);
    if (Object.hasOwn(oldPaths, path) && !isPathItem(oldPaths[path])) {
      throw new OpenApiEditError(`The source's path item for ${path} is not an object. Fix it in the source editor.`);
    }
    const pathItem = oldPaths[path];
    const method = operation.method.toLowerCase();
    if (isPathItem(pathItem) && Object.hasOwn(pathItem, method) && !isPathItem(pathItem[method])) {
      throw new OpenApiEditError(
        `The source has an invalid ${operation.method.toUpperCase()} operation at ${path}. Fix it in the source editor.`,
      );
    }
  }
  // Clone each path separately: YAML aliases must not link edits across paths.
  const paths = Object.fromEntries(Object.entries(oldPaths).map(([path, item]) => [path, structuredClone(item)]));
  const removedFrom = new Set<string>();
  // Keep retained keys in place, but remove deleted or moved form operations first.
  // Read originals from oldPaths so moves and swaps cannot overwrite their source.
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isPathItem(pathItem)) continue;
    for (const method of Object.keys(pathItem)) {
      if (
        methods.includes(method.toUpperCase()) &&
        isPathItem(pathItem[method]) &&
        !operations.some(
          (operation) =>
            operation.sourcePath === path &&
            operation.sourceMethod === method &&
            operation.path.trim() &&
            destinationPath(operation.path) === path &&
            operation.method.toLowerCase() === method,
        )
      ) {
        delete pathItem[method];
        removedFrom.add(path);
      }
    }
  }
  for (const operation of operations) {
    if (!operation.path.trim()) continue;
    const path = destinationPath(operation.path);
    if (!Object.hasOwn(paths, path)) {
      paths[path] = {};
    }
    const sourceItem = operation.sourcePath !== undefined ? oldPaths[operation.sourcePath] : undefined;
    const original =
      isPathItem(sourceItem) && operation.sourceMethod !== undefined ? sourceItem[operation.sourceMethod] : undefined;
    const next: Record<string, unknown> = isPathItem(original)
      ? { ...original }
      : { responses: { "200": { description: "Successful response" } } };
    if (!isPathItem(original) || operation.summary !== String(original.summary ?? "")) {
      // Clearing an existing summary writes ""; an untouched missing summary stays absent.
      next.summary = operation.summary;
    }
    (paths[path] as Record<string, unknown>)[operation.method.toLowerCase()] = next;
  }
  for (const path of removedFrom) {
    const pathItem = paths[path];
    if (isPathItem(pathItem) && Object.keys(pathItem).length === 0) delete paths[path];
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
