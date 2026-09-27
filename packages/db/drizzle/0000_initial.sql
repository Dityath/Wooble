CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "source_entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "target_entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvas_nodes" (
  "canvas_id" uuid NOT NULL REFERENCES "canvases"("id") ON DELETE CASCADE,
  "entity_id" uuid NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "parent_entity_id" uuid REFERENCES "entities"("id") ON DELETE SET NULL,
  "x" integer NOT NULL DEFAULT 0,
  "y" integer NOT NULL DEFAULT 0,
  "width" integer NOT NULL DEFAULT 220,
  "height" integer NOT NULL DEFAULT 120,
  PRIMARY KEY ("canvas_id", "entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canvas_connections" (
  "canvas_id" uuid NOT NULL REFERENCES "canvases"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  PRIMARY KEY ("canvas_id", "connection_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canvases_workspace_id_idx" ON "canvases" ("workspace_id");
CREATE INDEX IF NOT EXISTS "entities_workspace_id_idx" ON "entities" ("workspace_id");
CREATE INDEX IF NOT EXISTS "entities_type_idx" ON "entities" ("type");
CREATE INDEX IF NOT EXISTS "connections_workspace_id_idx" ON "connections" ("workspace_id");
CREATE INDEX IF NOT EXISTS "connections_source_entity_id_idx" ON "connections" ("source_entity_id");
CREATE INDEX IF NOT EXISTS "connections_target_entity_id_idx" ON "connections" ("target_entity_id");
CREATE INDEX IF NOT EXISTS "canvas_nodes_canvas_id_idx" ON "canvas_nodes" ("canvas_id");
CREATE INDEX IF NOT EXISTS "canvas_nodes_parent_entity_id_idx" ON "canvas_nodes" ("parent_entity_id");
CREATE INDEX IF NOT EXISTS "canvas_connections_canvas_id_idx" ON "canvas_connections" ("canvas_id");
