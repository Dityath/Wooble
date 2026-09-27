import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://architecture:architecture@localhost:5432/architecture_canvas";
export const pool = new Pool({ connectionString, max: 10 });
export const db = drizzle(pool, { schema });
