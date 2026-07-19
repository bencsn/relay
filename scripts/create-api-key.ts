import { loadServerConfig } from "@relay/config";
import { bootstrapAccount, connectDatabase, migrate } from "@relay/db";

const config = loadServerConfig();
const nameIndex = process.argv.indexOf("--name");
const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : undefined;
if (!name) throw new Error("Usage: bun scripts/create-api-key.ts --name <account-name>");

const sql = connectDatabase(config.DATABASE_URL, { max: 1 });
try {
  await migrate(sql);
  const created = await bootstrapAccount(sql, config.KEY_PEPPER, name);
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
