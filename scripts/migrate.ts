import { loadServerConfig } from "@relay/config";
import { connectDatabase, migrate } from "@relay/db";

const config = loadServerConfig();
const sql = connectDatabase(config.DATABASE_URL, { max: 1 });
try {
  await migrate(sql);
  console.log("Relay database migrations are up to date.");
} finally {
  await sql.end();
}
