import { loadServerConfig } from "@relay/config";
import { bootstrapAccount, connectDatabase, createPairingCode, migrate } from "@relay/db";

if (!process.argv.includes("--show-secret") || !process.stdout.isTTY) {
  throw new Error(
    "Refusing to reveal bootstrap credentials without --show-secret on an interactive terminal.",
  );
}

const config = loadServerConfig();
const sql = connectDatabase(config.DATABASE_URL, { max: 1 });
try {
  await migrate(sql);
  const created = await bootstrapAccount(
    sql,
    config.KEY_PEPPER,
    "Relay local owner",
    config.RELAY_BOOTSTRAP_API_KEY,
  );
  const pairingCode = await createPairingCode(sql, config.DEVICE_TOKEN_PEPPER, created.accountId);
  // This explicit, interactive-only command is the one-time credential delivery channel.
  // codeql[js/clear-text-logging]
  console.log(JSON.stringify({ api_key: created.key, pairing_code: pairingCode }, null, 2));
} finally {
  await sql.end();
}
