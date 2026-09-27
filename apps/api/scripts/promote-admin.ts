import { eq } from "drizzle-orm";
import { db, pool, users } from "@wooble/db";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: bun run --cwd apps/api admin:promote person@example.com");
  process.exitCode = 1;
} else {
  const [user] = await db
    .update(users)
    .set({ systemRole: "admin" })
    .where(eq(users.email, email))
    .returning({ email: users.email });
  if (!user) {
    console.error("Register this email before promoting it.");
    process.exitCode = 1;
  } else console.log(`System admin enabled for ${user.email}.`);
}
await pool.end();
