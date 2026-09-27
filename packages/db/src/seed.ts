import { db, pool, canvases, canvasConnections, canvasNodes, connections, entities, workspaces } from "./index";
import type { EntityMetadata, EntityType } from "@wooble/domain";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  enterprise: "00000000-0000-4000-8000-000000000010",
  systemA: "00000000-0000-4000-8000-000000000101",
  systemB: "00000000-0000-4000-8000-000000000102",
  frontendA: "00000000-0000-4000-8000-000000000201",
  gatewayA: "00000000-0000-4000-8000-000000000202",
  auth: "00000000-0000-4000-8000-000000000203",
  master: "00000000-0000-4000-8000-000000000204",
  authDb: "00000000-0000-4000-8000-000000000205",
  masterDb: "00000000-0000-4000-8000-000000000206",
  frontendB: "00000000-0000-4000-8000-000000000207",
  gatewayB: "00000000-0000-4000-8000-000000000208",
  serviceB1: "00000000-0000-4000-8000-000000000209",
  serviceB2: "00000000-0000-4000-8000-000000000210",
  dbB1: "00000000-0000-4000-8000-000000000211",
  dbB2: "00000000-0000-4000-8000-000000000212",
};

const stamp = new Date();

await db.transaction(async (tx) => {
  await tx
    .insert(workspaces)
    .values({
      id: ids.workspace,
      name: "Example Engineering",
      description: "Fictional architecture workspace for local exploration.",
      updatedAt: stamp,
    })
    .onConflictDoUpdate({
      target: workspaces.id,
      set: {
        name: "Example Engineering",
        description: "Fictional architecture workspace for local exploration.",
        updatedAt: stamp,
      },
    });

  const canvasRows = [
    {
      id: ids.enterprise,
      workspaceId: ids.workspace,
      name: "Enterprise Architecture",
      description: "A shared view of the core platform systems and the services that connect them.",
      updatedAt: stamp,
    },
  ];
  for (const row of canvasRows)
    await tx
      .insert(canvases)
      .values(row)
      .onConflictDoUpdate({
        target: canvases.id,
        set: { name: row.name, description: row.description, updatedAt: stamp },
      });

  const entityRows: Array<[string, EntityType, string, string, EntityMetadata]> = [
    [
      ids.systemA,
      "system",
      "Core Identity",
      "Authentication and master data services.",
      { technology: "System boundary" },
    ],
    [
      ids.systemB,
      "system",
      "Operations Platform",
      "Operational services with independent storage.",
      { technology: "System boundary" },
    ],
    [
      ids.frontendA,
      "frontend",
      "Identity Console",
      "Web experience for identity and access workflows.",
      {
        framework: "React",
        language: "TypeScript",
        status: "implemented",
        repositoryUrl: "https://github.com/example/identity-console",
      },
    ],
    [
      ids.gatewayA,
      "gateway",
      "Identity API Gateway",
      "Public API entry point for identity services.",
      {
        technology: "Go",
        language: "Go",
        status: "implemented",
        repositoryUrl: "https://github.com/example/identity-gateway",
        artifactUrl: "harbor.example.com/identity/gateway",
      },
    ],
    [
      ids.auth,
      "service",
      "Auth Service",
      "Authentication, sessions, and access token management.",
      {
        language: "Go",
        framework: "Fiber",
        status: "implemented",
        interfaces: ["gRPC", "REST"],
        repositoryUrl: "https://github.com/example/auth-service",
        artifactUrl: "harbor.example.com/identity/auth-service",
      },
    ],
    [
      ids.master,
      "service",
      "Master Service",
      "Shared identity records and reference data.",
      {
        language: "Go",
        framework: "Connect RPC",
        status: "in-progress",
        interfaces: ["gRPC"],
        repositoryUrl: "https://github.com/example/master-service",
        artifactUrl: "harbor.example.com/identity/master-service",
      },
    ],
    [
      ids.authDb,
      "database",
      "Auth Database",
      "Primary store for identity and session records.",
      { engine: "PostgreSQL", version: "16" },
    ],
    [
      ids.masterDb,
      "database",
      "Master Database",
      "Primary store for shared reference data.",
      { engine: "PostgreSQL", version: "16" },
    ],
    [
      ids.frontendB,
      "frontend",
      "Operations Portal",
      "Operations team web application.",
      { framework: "React", language: "TypeScript", status: "implemented" },
    ],
    [
      ids.gatewayB,
      "gateway",
      "Operations Gateway",
      "API entry point for operational workflows.",
      { technology: "Go", language: "Go", status: "implemented" },
    ],
    [
      ids.serviceB1,
      "service",
      "Permit Service",
      "Manages permit and entitlement workflows.",
      { language: "Go", framework: "Chi", status: "implemented", interfaces: ["gRPC", "REST"] },
    ],
    [
      ids.serviceB2,
      "service",
      "Session Service",
      "Tracks active operational sessions.",
      { language: "Rust", framework: "Axum", status: "in-progress", interfaces: ["gRPC"] },
    ],
    [ids.dbB1, "database", "Permit Store", "Local permit data store.", { engine: "SQLite", version: "3" }],
    [ids.dbB2, "database", "Session Store", "Local session data store.", { engine: "SQLite", version: "3" }],
  ];
  for (const [id, type, name, description, metadata] of entityRows) {
    await tx
      .insert(entities)
      .values({ id, workspaceId: ids.workspace, type, name, description, metadata, updatedAt: stamp })
      .onConflictDoUpdate({ target: entities.id, set: { type, name, description, metadata, updatedAt: stamp } });
  }

  const placementRows = [
    { canvasId: ids.enterprise, entityId: ids.systemA, parentEntityId: null, x: 0, y: 0, width: 500, height: 690 },
    { canvasId: ids.enterprise, entityId: ids.systemB, parentEntityId: null, x: 560, y: 0, width: 500, height: 690 },
    {
      canvasId: ids.enterprise,
      entityId: ids.frontendA,
      parentEntityId: ids.systemA,
      x: 25,
      y: 100,
      width: 165,
      height: 106,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.gatewayA,
      parentEntityId: ids.systemA,
      x: 310,
      y: 100,
      width: 165,
      height: 106,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.auth,
      parentEntityId: ids.systemA,
      x: 35,
      y: 320,
      width: 195,
      height: 126,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.master,
      parentEntityId: ids.systemA,
      x: 270,
      y: 320,
      width: 195,
      height: 126,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.authDb,
      parentEntityId: ids.systemA,
      x: 35,
      y: 540,
      width: 195,
      height: 110,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.masterDb,
      parentEntityId: ids.systemA,
      x: 270,
      y: 540,
      width: 195,
      height: 110,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.frontendB,
      parentEntityId: ids.systemB,
      x: 25,
      y: 100,
      width: 165,
      height: 106,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.gatewayB,
      parentEntityId: ids.systemB,
      x: 310,
      y: 100,
      width: 165,
      height: 106,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.serviceB1,
      parentEntityId: ids.systemB,
      x: 35,
      y: 320,
      width: 195,
      height: 126,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.serviceB2,
      parentEntityId: ids.systemB,
      x: 270,
      y: 320,
      width: 195,
      height: 126,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.dbB1,
      parentEntityId: ids.systemB,
      x: 35,
      y: 540,
      width: 195,
      height: 110,
    },
    {
      canvasId: ids.enterprise,
      entityId: ids.dbB2,
      parentEntityId: ids.systemB,
      x: 270,
      y: 540,
      width: 195,
      height: 110,
    },
  ];
  for (const row of placementRows)
    await tx
      .insert(canvasNodes)
      .values(row)
      .onConflictDoUpdate({
        target: [canvasNodes.canvasId, canvasNodes.entityId],
        set: { parentEntityId: row.parentEntityId, x: row.x, y: row.y, width: row.width, height: row.height },
      });

  const connectionRows = [
    [
      "00000000-0000-4000-8000-000000000301",
      ids.frontendA,
      ids.gatewayA,
      "rest",
      "REST",
      "The identity console calls its API gateway.",
    ],
    [
      "00000000-0000-4000-8000-000000000302",
      ids.gatewayA,
      ids.auth,
      "grpc",
      "gRPC",
      "The gateway delegates authentication requests.",
    ],
    [
      "00000000-0000-4000-8000-000000000303",
      ids.gatewayA,
      ids.master,
      "grpc",
      "gRPC",
      "The gateway delegates master data requests.",
    ],
    [
      "00000000-0000-4000-8000-000000000304",
      ids.auth,
      ids.master,
      "grpc",
      "gRPC",
      "Auth Service reads shared identity data.",
    ],
    [
      "00000000-0000-4000-8000-000000000305",
      ids.auth,
      ids.authDb,
      "database",
      "database",
      "Auth Service stores identity and session records.",
    ],
    [
      "00000000-0000-4000-8000-000000000306",
      ids.master,
      ids.masterDb,
      "database",
      "database",
      "Master Service stores reference data.",
    ],
    [
      "00000000-0000-4000-8000-000000000307",
      ids.frontendB,
      ids.gatewayB,
      "rest",
      "REST",
      "The operations portal calls its API gateway.",
    ],
    [
      "00000000-0000-4000-8000-000000000308",
      ids.gatewayB,
      ids.serviceB1,
      "grpc",
      "gRPC",
      "The gateway routes permit workflows.",
    ],
    [
      "00000000-0000-4000-8000-000000000309",
      ids.gatewayB,
      ids.serviceB2,
      "grpc",
      "gRPC",
      "The gateway routes session workflows.",
    ],
    [
      "00000000-0000-4000-8000-000000000310",
      ids.serviceB1,
      ids.serviceB2,
      "grpc",
      "gRPC",
      "Permit Service checks the active session.",
    ],
    [
      "00000000-0000-4000-8000-000000000311",
      ids.serviceB1,
      ids.dbB1,
      "database",
      "database",
      "Permit Service stores permit records.",
    ],
    [
      "00000000-0000-4000-8000-000000000312",
      ids.serviceB2,
      ids.dbB2,
      "database",
      "database",
      "Session Service stores active sessions.",
    ],
    [
      "00000000-0000-4000-8000-000000000313",
      ids.gatewayA,
      ids.gatewayB,
      "rest",
      "REST · cross-system",
      "Identity capabilities are exposed to the operations platform.",
    ],
  ] as const;
  for (const [id, sourceEntityId, targetEntityId, type, label, description] of connectionRows) {
    const row = {
      id,
      workspaceId: ids.workspace,
      sourceEntityId,
      targetEntityId,
      type,
      label,
      description,
      metadata: { contract: "Not configured", direction: "one-way" as const },
    };
    await tx.insert(connections).values(row).onConflictDoUpdate({ target: connections.id, set: row });
    await tx.insert(canvasConnections).values({ canvasId: ids.enterprise, connectionId: id }).onConflictDoNothing();
  }
});

await pool.end();
console.log("Seeded fictional example architecture.");
