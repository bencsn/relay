import { loadServerConfig } from "@relay/config";
import { connectDatabase, migrate, setAccountStatus } from "@relay/db";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const accountId = argument("--account-id");
const status = argument("--status");
if (!accountId || (status !== "active" && status !== "suspended")) {
  throw new Error(
    "Usage: bun scripts/set-account-status.ts --account-id <account-id> --status <active|suspended>",
  );
}

const config = loadServerConfig();
const sql = connectDatabase(config.DATABASE_URL, { max: 1 });
try {
  await migrate(sql);
  const changed = await setAccountStatus(sql, accountId, status);
  if (!changed) throw new Error("Account not found");
  console.log(JSON.stringify({ account_id: accountId, status }));
} finally {
  await sql.end();
}
