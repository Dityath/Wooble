import { runtimeConfigErrors } from "./lib/config";

// Check the configuration before importing the app, whose modules read it as they load.
const configErrors = runtimeConfigErrors(process.env);
if (configErrors.length) {
  console.error(
    `The Wooble API cannot start because its configuration is invalid:\n${configErrors.map((error) => `- ${error}`).join("\n")}`,
  );
  process.exit(1);
}
const { createApp } = await import("./app");
const { stopLiveServer } = await import("./lib/live");
const { pool } = await import("@wooble/db");
const { startSingleInstanceGate, stopSingleInstanceGate } = await import("./lib/instance-gate");

const app = await createApp();
const port = Number(process.env.API_PORT ?? 3001);
app.listen({ port, hostname: "0.0.0.0" });
void startSingleInstanceGate(pool);
console.log(`API listening at http://0.0.0.0:${port}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopLiveServer(app);
  } finally {
    try {
      await stopSingleInstanceGate();
    } finally {
      await pool.end();
    }
  }
};
const onSignal = () =>
  void shutdown().catch((error) => {
    console.error("Could not shut down API cleanly", error);
    process.exitCode = 1;
  });
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
