CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "password_hash" text NOT NULL,
  "system_role" text NOT NULL DEFAULT 'user' CHECK ("system_role" IN ('admin', 'user')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sessions" (
  "token_hash" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE TABLE "workspace_members" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('manager', 'member')),
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "canvas_members" (
  "canvas_id" uuid NOT NULL REFERENCES "canvases"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('editor', 'viewer')),
  PRIMARY KEY ("canvas_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX "canvas_members_user_idx" ON "canvas_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL UNIQUE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "canvas_id" uuid REFERENCES "canvases"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('member', 'editor', 'viewer')),
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "remaining_uses" integer NOT NULL DEFAULT 1 CHECK ("remaining_uses" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("canvas_id" IS NULL AND "role" = 'member') OR ("canvas_id" IS NOT NULL AND "role" IN ('viewer', 'editor')))
);
