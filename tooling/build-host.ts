import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

const allTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
  "bun-windows-x64",
];
const targets = process.argv.includes("--all") ? allTargets : [undefined];
const outputDirectory = join(process.cwd(), "dist", "host-bin");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const outputs: string[] = [];
for (const target of targets) {
  const suffix = target?.replace(/^bun-/, "") ?? `${process.platform}-${process.arch}`;
  const output = join(
    outputDirectory,
    `relay-host-${suffix}${target === "bun-windows-x64" ? ".exe" : ""}`,
  );
  const args = [
    "bun",
    "build",
    "apps/host/src/index.ts",
    "--compile",
    "--minify",
    `--outfile=${output}`,
  ];
  if (target) args.push(`--target=${target}`);
  const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Host build failed for ${target ?? "current platform"}`);
  if (!output.endsWith(".exe")) await chmod(output, 0o755);
  outputs.push(output);
}

const checksums: string[] = [];
for (const output of outputs) {
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(output).arrayBuffer())
    .digest("hex");
  checksums.push(`${hash}  ${basename(output)}`);
}
await Bun.write(join(outputDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`Built ${outputs.length} relay-host executable(s) in ${outputDirectory}`);
