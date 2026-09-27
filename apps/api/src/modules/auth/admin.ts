import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, users } from "@wooble/db";
import { badRequest, notFound } from "../../lib/http-error";
import type { Api } from "../../lib/auth";

const paramsSchema = z.object({ userId: z.string().uuid() });
const roleSchema = z.object({ systemRole: z.enum(["admin", "user"]) });
export function adminRoutes(app: Api) {
  app.get("/api/admin/users", async () =>
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        systemRole: users.systemRole,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.name)),
  );
  app.patch("/api/admin/users/:userId", async (context) => {
    const params = paramsSchema.safeParse(context.params);
    const body = roleSchema.safeParse(context.body);
    if (!params.success || !body.success) return badRequest(context, "Invalid user role");
    if (params.data.userId === context.actor?.id && body.data.systemRole !== "admin")
      return badRequest(context, "You cannot remove your own admin access");
    const [user] = await db
      .update(users)
      .set({ systemRole: body.data.systemRole })
      .where(eq(users.id, params.data.userId))
      .returning({ id: users.id, name: users.name, email: users.email, systemRole: users.systemRole });
    if (!user) return notFound(context, "User not found");
    return user;
  });
}
