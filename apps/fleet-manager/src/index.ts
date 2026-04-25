import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const db = createPool(config.DATABASE_URL);

  const app = await buildServer({ config, db });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await db.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "shutdown error");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.FLEET_MANAGER_HOST, port: config.FLEET_MANAGER_PORT });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
