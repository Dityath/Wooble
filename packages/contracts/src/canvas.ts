import { z } from "zod";
import { connectionTypes, entityTypes } from "@wooble/domain";

export const canvasIdParamsSchema = z.object({ canvasId: z.string().uuid() });
export const createCanvasSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
});
export const createCanvasEntitySchema = z.object({
  type: z.enum(entityTypes),
  name: z.string().trim().max(100).default(""),
  x: z.number().int(),
  y: z.number().int(),
  parentEntityId: z.string().uuid().nullable(),
});
export const createCanvasConnectionSchema = z
  .object({
    sourceEntityId: z.string().uuid(),
    targetEntityId: z.string().uuid(),
    type: z.enum(connectionTypes).default("rest"),
  })
  .refine((value) => value.sourceEntityId !== value.targetEntityId, "Choose two different nodes");
const connectionPointSchema = z.object({
  x: z.number().int().min(-1000000).max(1000000),
  y: z.number().int().min(-1000000).max(1000000),
});
export const updateCanvasConnectionBendSchema = z.object({
  bend: z.union([connectionPointSchema, z.array(connectionPointSchema).max(12)]).nullable(),
});
export const autoNeatCanvasSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    placements: z.array(
      z.object({
        entityId: z.string().uuid(),
        parentEntityId: z.string().uuid().nullable(),
        x: z.number().int().min(-1000000).max(1000000),
        y: z.number().int().min(-1000000).max(1000000),
        width: z.number().int().positive().max(100000),
        height: z.number().int().positive().max(100000),
      }),
    ),
    connections: z.array(
      z.object({
        connectionId: z.string().uuid(),
        bend: connectionPointSchema,
      }),
    ),
  })
  .superRefine(({ placements, connections }, context) => {
    if (new Set(placements.map((item) => item.entityId)).size !== placements.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate node placements" });
    if (new Set(connections.map((item) => item.connectionId)).size !== connections.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate connector routes" });
  });
const canvasPlacementSchema = z.object({
  entityId: z.string().uuid(),
  parentEntityId: z.string().uuid().nullable(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const updatePlacementsSchema = z
  .object({
    placements: z.array(canvasPlacementSchema),
  })
  .superRefine(({ placements }, context) => {
    const entityIds = new Set<string>();
    placements.forEach((placement, index) => {
      if (entityIds.has(placement.entityId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["placements", index, "entityId"],
          message: "Each entity may only have one placement",
        });
      }
      entityIds.add(placement.entityId);
    });
  });

export const canvasSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  shareMode: z.enum(["restricted", "link"]),
  updatedAt: z.string(),
  systemCount: z.number().int().nonnegative(),
  serviceCount: z.number().int().nonnegative(),
});

export const canvasGraphSchema = z.object({
  canvas: z.object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    shareMode: z.enum(["restricted", "link"]),
    updatedAt: z.string(),
  }),
  entities: z.array(
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      type: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      metadata: z.record(z.unknown()),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  placements: z.array(
    z.object({
      canvasId: z.string().uuid(),
      entityId: z.string().uuid(),
      parentEntityId: z.string().uuid().nullable(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      sourceEntityId: z.string().uuid(),
      targetEntityId: z.string().uuid(),
      type: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      metadata: z.record(z.unknown()),
      bend: z.union([connectionPointSchema, z.array(connectionPointSchema).max(12)]).nullable(),
    }),
  ),
});

export const canvasActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const canvasEventSchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorName: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().uuid().nullable(),
  targetName: z.string().nullable(),
  metadata: z.record(z.unknown()),
  undoneAt: z.string().nullable(),
  createdAt: z.string(),
});

export type CanvasEvent = z.infer<typeof canvasEventSchema>;

export type CreateCanvasInput = z.infer<typeof createCanvasSchema>;
