import { z } from "zod";
import { connectionTypes } from "@wooble/domain";

export const connectionIdParamsSchema = z.object({ connectionId: z.string().uuid() });
export const updateConnectionSchema = z
  .object({
    type: z.enum(connectionTypes).optional(),
    label: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    metadata: z
      .object({
        contract: z.string().trim().max(500).nullable().optional(),
        contractBody: z.string().max(100000).nullable().optional(),
        documentation: z.string().trim().max(20000).nullable().optional(),
        direction: z.enum(["one-way", "two-way"]).nullable().optional(),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "No changes provided");
export const connectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceEntityId: z.string().uuid(),
  targetEntityId: z.string().uuid(),
  type: z.enum(connectionTypes),
  label: z.string(),
  description: z.string().nullable(),
  metadata: z.record(z.unknown()),
});
