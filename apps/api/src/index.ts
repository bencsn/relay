import { loadServerConfig } from "@relay/config";
import { bootstrapAccount, connectDatabase, migrate } from "@relay/db";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { attachHostWebSocket } from "./host-websocket.ts";
import { createLogger } from "./logger.ts";
import { startWorkers } from "./workers.ts";

const config = loadServerConfig();
const logger = createLogger(config.LOG_LEVEL);
const sql = connectDatabase(config.DATABASE_URL);

await migrate(sql);
if (config.RELAY_BOOTSTRAP_API_KEY) {
  await bootstrapAccount(sql, config.KEY_PEPPER, "Relay bootstrap", config.RELAY_BOOTSTRAP_API_KEY);
}

const app = createApp({ config, sql, logger });
attachHostWebSocket(app, { config, sql, logger });
const stopWorkers = startWorkers(sql, config, logger);

const server = Bun.serve({ port: config.PORT, fetch: app.fetch, websocket });
logger.info("api.started", { port: config.PORT, public_base_url: config.PUBLIC_BASE_URL });

async function shutdown(signal: string) {
  logger.info("api.stopping", { signal });
  stopWorkers();
  server.stop(true);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
