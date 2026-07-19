import { loadServerConfig } from "@relay/config";
import { bootstrapAccount, connectDatabase, migrate } from "@relay/db";

const config = loadServerConfig();
const nameIndex = process.argv.indexOf("--name");
const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : undefined;
if (!name) throw new Error("Usage: bun scripts/create-api-key.ts --name <account-name>");
if (!process.argv.includes("--show-secret") || !process.stdout.isTTY) {
  throw new Error(
    "Refusing to reveal the new API key without --show-secret on an interactive terminal.",
  );
}

const sql = connectDatabase(config.DATABASE_URL, { max: 1 });
try {
  await migrate(sql);
  const created = await bootstrapAccount(sql, config.KEY_PEPPER, name);
  // This explicit, interactive-only command is the one-time credential delivery channel.
  // codeql[js/clear-text-logging]
  console.log(
    JSON.stringify(
      { account_id: created.accountId, api_key_id: created.id, api_key: created.key },
      null,
      2,
    ),
  );
} finally {
  await sql.end();
}
