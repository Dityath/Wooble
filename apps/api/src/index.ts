import { createApp } from "./app";
import { stopLiveServer } from "./lib/live";
import { pool } from "@wooble/db";

const app = await createApp();
const port = Number(process.env.API_PORT ?? 3001);
app.listen({ port, hostname: "0.0.0.0" });
console.log(`API listening at http://0.0.0.0:${port}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopLiveServer(app);
  } finally {
    await pool.end();
  }
};
const onSignal = () =>
  void shutdown().catch((error) => {
    console.error("Could not shut down API cleanly", error);
    process.exitCode = 1;
  });
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
