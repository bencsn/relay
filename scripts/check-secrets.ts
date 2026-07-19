export {};

const child = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  stdout: "pipe",
  stderr: "inherit",
});
const files = (await new Response(child.stdout).text()).split("\0").filter(Boolean);
if ((await child.exited) !== 0) throw new Error("Could not enumerate repository files");

const forbiddenNames = files.filter(
  (file) =>
    /(^|\/)\.env($|\.)/.test(file) &&
    !file.endsWith(".env.example") &&
    !file.endsWith("/.env.example"),
);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opusr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const findings: string[] = forbiddenNames.map(
  (file) => `${file}: local environment file must not be committed`,
);

for (const file of files) {
  if (file === "bun.lock" || file.startsWith(".git/")) continue;
  const blob = Bun.file(file);
  if (!(await blob.exists()) || blob.size > 2_000_000) continue;
  const text = await blob.text().catch(() => "");
  for (const pattern of patterns) {
    if (pattern.test(text)) findings.push(`${file}: matched ${pattern.source}`);
  }
}

if (findings.length) {
  console.error(`Potential secret material detected:\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`Secret scan passed for ${files.length} repository files.`);
