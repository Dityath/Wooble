import { z } from "zod";
import { entityTypes } from "@wooble/domain";

export const entityIdParamsSchema = z.object({ entityId: z.string().uuid() });
export const updateEntitySchema = z
  .object({
    type: z.enum(entityTypes).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    metadata: z
      .object({
        language: z.string().trim().max(100).nullable().optional(),
        framework: z.string().trim().max(100).nullable().optional(),
        technology: z.string().trim().max(100).nullable().optional(),
        engine: z.string().trim().max(100).nullable().optional(),
        version: z.string().trim().max(100).nullable().optional(),
        repositoryUrl: z.string().trim().max(500).nullable().optional(),
        artifactUrl: z.string().trim().max(500).nullable().optional(),
        status: z.enum(["planned", "in-progress", "implemented", "deprecated"]).nullable().optional(),
        interfaces: z.array(z.string().trim().min(1).max(100)).max(20).nullable().optional(),
        technologyStack: z.array(z.string().trim().min(1).max(100)).max(100).nullable().optional(),
        technologyVersions: z.record(z.string().max(100), z.string().trim().max(50)).nullable().optional(),
        documentation: z.string().trim().max(20000).nullable().optional(),
        schemaSql: z.string().max(100000).nullable().optional(),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "No changes provided");
export const entitySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  type: z.enum(entityTypes),
  name: z.string(),
  description: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
