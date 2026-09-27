import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, sessions, users, workspaceMembers, workspaces } from "@wooble/db";
import { badRequest, postgresErrorCode } from "../../lib/http-error";
import {
  clientIp,
  createSession,
  hashPassword,
  hashToken,
  requireActor,
  sessionCookie,
  sessionToken,
  verifyPassword,
  type Api,
} from "../../lib/auth";

const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email,
    password: z.string().min(12).max(128),
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
const loginSchema = z.object({ email, password: z.string() });
const profileSchema = z.object({ name: z.string().trim().min(2).max(100) });
const passwordSchema = z.object({ currentPassword: z.string(), newPassword: z.string().min(12).max(128) });
const attempts = new Map<string, { count: number; until: number }>();
export function resetLoginAttempts() {
  attempts.clear();
}
function limited(ip: string) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.until < now) {
    attempts.set(ip, { count: 1, until: now + 15 * 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}
function publicUser(user: typeof users.$inferSelect) {
  return { id: user.id, name: user.name, email: user.email, systemRole: user.systemRole };
}
export function authRoutes(app: Api) {
  app.post("/api/auth/register", async (context) => {
    if (limited(clientIp(context))) {
      context.set.status = 429;
      return { message: "Too many attempts. Try again later" };
    }
    const parsed = registerSchema.safeParse(context.body);
    if (!parsed.success) return badRequest(context, parsed.error.issues[0]?.message ?? "Invalid registration");
    const passwordHash = await hashPassword(parsed.data.password);
    try {
      const user = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ name: parsed.data.name, email: parsed.data.email, passwordHash })
          .returning();
        const [workspace] = await tx.insert(workspaces).values({ name: "My Workspace" }).returning();
        await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: created.id, role: "manager" });
        return created;
      });
      await createSession(user.id, context);
      context.set.status = 201;
      return publicUser(user);
    } catch (error) {
      if (postgresErrorCode(error) === "23505") {
        context.set.status = 409;
        return { message: "Email is already registered" };
      }
      throw error;
    }
  });
  app.post("/api/auth/login", async (context) => {
    if (limited(clientIp(context))) {
      context.set.status = 429;
      return { message: "Too many attempts. Try again later" };
    }
    const parsed = loginSchema.safeParse(context.body);
    if (!parsed.success) return badRequest(context, "Invalid email or password");
    const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      context.set.status = 401;
      return { message: "Invalid email or password" };
    }
    await createSession(user.id, context);
    return publicUser(user);
  });
  app.get("/api/auth/me", async (context) => context.actor);
  app.post("/api/auth/logout", async (context) => {
    const token = sessionToken(context.headers.cookie);
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    context.set.headers["set-cookie"] = sessionCookie("", 0);
    return { ok: true };
  });
  app.patch("/api/auth/profile", async (context) => {
    const parsed = profileSchema.safeParse(context.body);
    if (!parsed.success) return badRequest(context, parsed.error.issues[0]?.message ?? "Invalid profile");
    const [user] = await db
      .update(users)
      .set({ name: parsed.data.name })
      .where(eq(users.id, requireActor(context.actor).id))
      .returning();
    return publicUser(user);
  });
  app.put("/api/auth/password", async (context) => {
    const parsed = passwordSchema.safeParse(context.body);
    if (!parsed.success) return badRequest(context, parsed.error.issues[0]?.message ?? "Invalid password");
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, requireActor(context.actor).id))
      .limit(1);
    if (!user || !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      context.set.status = 403;
      return { message: "Current password is incorrect" };
    }
    const passwordHash = await hashPassword(parsed.data.newPassword);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
    });
    context.set.headers["set-cookie"] = sessionCookie("", 0);
    return { ok: true };
  });
}
