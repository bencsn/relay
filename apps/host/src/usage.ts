import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { usagePath } from "./config.ts";

interface UsageState {
  date: string;
  jobs: number;
  tokens: number;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function readUsage(): Promise<UsageState> {
  try {
    const usage = JSON.parse(await readFile(usagePath(), "utf8")) as UsageState;
    if (usage.date === today()) return usage;
  } catch {
    // A missing or malformed counter starts a new local day.
  }
  return { date: today(), jobs: 0, tokens: 0 };
}

export async function addUsage(tokens: number) {
  const usage = await readUsage();
  usage.jobs += 1;
  usage.tokens += tokens;
  await mkdir(dirname(usagePath()), { recursive: true, mode: 0o700 });
  await Bun.write(usagePath(), `${JSON.stringify(usage)}\n`);
  await chmod(usagePath(), 0o600);
  return usage;
}
