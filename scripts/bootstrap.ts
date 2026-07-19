import { loadServerConfig } from "@relay/config";
import { bootstrapAccount, connectDatabase, createPairingCode, migrate } from "@relay/db";

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
  console.log(JSON.stringify({ api_key: created.key, pairing_code: pairingCode }, null, 2));
} finally {
  await sql.end();
}
