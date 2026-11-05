/**
 * Compiles git-mirror into standalone executables with `bun build --compile` (Bun bundles its own runtime,
 * so the binaries need neither Node.js nor npm).
 *
 *   tsx scripts/build-binaries.ts                  # every platform (Bun cross-compiles)
 *   tsx scripts/build-binaries.ts host             # only the platform you are on
 *   tsx scripts/build-binaries.ts linux-x64 --gzip # specific platforms, plus .gz files for release
 *
 * Output: dist/bin/git-mirror-<platform>[.gz]
 */
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** Release asset platform -> Bun compile target. x64 uses "baseline" builds, which run on CPUs without AVX2. */
export const TARGETS = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl-baseline",
  "linux-arm64-musl": "bun-linux-arm64-musl",
  "darwin-x64": "bun-darwin-x64-baseline",
  "darwin-arm64": "bun-darwin-arm64",
} as const;

type PlatformName = keyof typeof TARGETS;

const OUT_DIR = "dist/bin";

function hostPlatform(): PlatformName {
  const cpu = arch() === "arm64" ? "arm64" : "x64";
  if (platform() === "darwin") return `darwin-${cpu}`;
  if (platform() !== "linux") throw new Error(`Unsupported host platform: ${platform()}`);
  // Alpine and other musl distros ship the musl dynamic loader instead of glibc's.
  const musl = existsSync(`/lib/ld-musl-${cpu === "x64" ? "x86_64" : "aarch64"}.so.1`);
  return `linux-${cpu}${musl ? "-musl" : ""}`;
}

/**
 * Bun appends the bundled app to a runtime that was already signed, so the signature it ships with no longer
 * matches ("invalid signature (code or signature have been modified)"). Re-sign ad hoc so the binary passes
 * `codesign --verify`; Apple Silicon only runs code with a valid signature.
 */
function signMacBinary(path: string): void {
  if (platform() !== "darwin") {
    console.warn(`  ! ${path} is not re-signed (codesign needs macOS); its signature is invalid until it is.`);
    return;
  }
  for (const args of [["--force", "--sign", "-", path], ["--verify", "--strict", path]]) {
    const result = spawnSync("codesign", args, { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`codesign ${args.join(" ")} failed`);
  }
  console.log(`  ✓ signed (ad hoc) and verified`);
}

async function gzipFile(path: string): Promise<void> {
  await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(`${path}.gz`));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const gzip = args.includes("--gzip");
  const requested = args.filter((arg) => !arg.startsWith("--"));
  const names: PlatformName[] =
    requested.length === 0
      ? (Object.keys(TARGETS) as PlatformName[])
      : requested.map((name) => {
          if (name === "host") return hostPlatform();
          if (!(name in TARGETS)) throw new Error(`Unknown platform "${name}". Choose from: host, ${Object.keys(TARGETS).join(", ")}`);
          return name as PlatformName;
        });

  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  mkdirSync(OUT_DIR, { recursive: true });

  for (const name of names) {
    const outfile = join(OUT_DIR, `git-mirror-${name}`);
    console.log(`→ ${name} (${TARGETS[name]}) v${version}`);
    const result = spawnSync(
      "bun",
      ["build", "src/cli/index.ts", "--compile", "--minify", "--sourcemap=none", `--target=${TARGETS[name]}`, "--outfile", outfile],
      { stdio: "inherit" },
    );
    if (result.error) throw new Error(`Could not run bun (${result.error.message}). Install it from https://bun.sh.`);
    if (result.status !== 0) process.exit(result.status ?? 1);
    // Bun writes a source map next to the binary even with --sourcemap=none; it is not needed.
    rmSync(join(OUT_DIR, "index.js.map"), { force: true });
    if (name.startsWith("darwin-")) signMacBinary(outfile);
    if (gzip) await gzipFile(outfile);
  }
}

await main();
