import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Runner } from "./exec.js";
import { TOKEN_ENV_VARS, type Env } from "./providers/index.js";
import { redactUrl } from "./remote.js";

/** Facts about the machine and process, injectable so the report can be tested. */
export interface HostInfo {
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  /** Path of the running executable (the standalone binary, or node). */
  execPath: string;
  /** Script path when running under node (the npm install). */
  scriptPath?: string;
  runtime: { name: "bun" | "node"; version: string };
  homedir: string;
  tmpdir: string;
  stdoutIsTTY: boolean;
  readFile(path: string): string | undefined;
  exists(path: string): boolean;
  isExecutable(path: string): boolean;
}

export function currentHost(): HostInfo {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    execPath: process.execPath,
    scriptPath: bun ? undefined : process.argv[1],
    runtime: bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node },
    homedir: homedir(),
    tmpdir: tmpdir(),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    exists: existsSync,
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type Status = "ok" | "warn" | "error" | "info";

export interface Row {
  label: string;
  value: string;
  status?: Status;
}

export interface Section {
  title: string;
  rows: Row[];
}

export interface Diagnostics {
  title: string;
  sections: Section[];
  /** Human-readable problems worth fixing, most important first. */
  problems: string[];
}

export interface DiagnosticsOptions {
  version: string;
  runner: Runner;
  env: Env;
  host?: HostInfo;
}

/** Each probe gets a short time limit so the report can never hang on a misbehaving tool. */
const PROBE_TIMEOUT_MS = 5_000;

/** Every executable called `name` on PATH, in lookup order. */
export function findOnPath(name: string, env: Env, host: Pick<HostInfo, "isExecutable">): string[] {
  const seen = new Set<string>();
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!seen.has(candidate) && host.isExecutable(candidate)) seen.add(candidate);
  }
  return [...seen];
}

export async function collectDiagnostics({ version, runner, env, host = currentHost() }: DiagnosticsOptions): Promise<Diagnostics> {
  const run = async (command: string, args: string[]) => {
    try {
      const result = await runner(command, args, { timeoutMs: PROBE_TIMEOUT_MS });
      return { ...result, missing: false };
    } catch {
      // Not installed (spawn ENOENT) or not runnable.
      return { code: 127, stdout: "", stderr: "", timedOut: false, missing: true };
    }
  };
  const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";
  const tidy = (path: string) => (host.homedir && path.startsWith(`${host.homedir}/`) ? `~${path.slice(host.homedir.length)}` : path);
  const problems: string[] = [];

  // git-mirror itself.
  const standalone = host.runtime.name === "bun";
  const installs = findOnPath("git-mirror", env, host);
  const self: Row[] = [
    { label: "install", value: standalone ? "standalone binary" : "npm package" },
    { label: "runtime", value: standalone ? `Bun ${host.runtime.version}` : `Node.js ${host.runtime.version}` },
    { label: "executable", value: tidy(standalone ? host.execPath : (host.scriptPath ?? host.execPath)) },
    {
      label: "on PATH",
      value: installs.length ? installs.map(tidy).join(", ") : "not found",
      status: installs.length > 1 ? "warn" : installs.length ? "ok" : "warn",
    },
  ];
  if (installs.length > 1) problems.push(`Several git-mirror installs are on PATH; the first one wins: ${installs.map(tidy).join(", ")}`);

  // Operating system.
  const system: Row[] = [];
  if (host.platform === "darwin") {
    const product = await run("sw_vers", ["-productVersion"]);
    const build = await run("sw_vers", ["-buildVersion"]);
    system.push({ label: "os", value: `macOS ${firstLine(product.stdout) || "?"} (${firstLine(build.stdout) || "?"}), Darwin ${host.osRelease}` });
    const translated = await run("sysctl", ["-n", "sysctl.proc_translated"]);
    const rosetta = firstLine(translated.stdout) === "1";
    system.push({ label: "arch", value: rosetta ? `${host.arch} (running under Rosetta on Apple Silicon)` : host.arch });
    if (rosetta) problems.push("Running the Intel build under Rosetta; the native arm64 build is faster (reinstall with install.sh).");
  } else if (host.platform === "linux") {
    const osRelease = host.readFile("/etc/os-release") ?? "";
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1];
    system.push({ label: "os", value: `${pretty ?? "Linux"}, kernel ${host.osRelease}` });
    system.push({ label: "arch", value: host.arch });
    const muslLoader = ["x86_64", "aarch64"].some((cpu) => host.exists(`/lib/ld-musl-${cpu}.so.1`));
    const glibc = muslLoader ? undefined : firstLine((await run("getconf", ["GNU_LIBC_VERSION"])).stdout);
    system.push({ label: "libc", value: muslLoader ? "musl" : glibc || "glibc (version unknown)" });
  } else {
    system.push({ label: "os", value: `${host.platform} ${host.osRelease}` }, { label: "arch", value: host.arch });
  }
  system.push(
    { label: "shell", value: env.SHELL ?? "unknown" },
    { label: "terminal", value: `${host.stdoutIsTTY ? "interactive" : "not a TTY"}${env.TERM ? `, TERM=${env.TERM}` : ""}${env.NO_COLOR ? ", NO_COLOR set" : ""}` },
    { label: "temp dir", value: tidy(host.tmpdir) },
  );

  // Dependencies.
  const ghHost = env.GH_HOST || "github.com";
  const dependencies: Row[] = [];

  const git = await run("git", ["--version"]);
  if (git.missing || git.code !== 0) {
    dependencies.push({ label: "git", value: "not found (required: https://git-scm.com/downloads)", status: "error" });
    problems.push("git is not installed or not on PATH; git-mirror cannot work without it.");
  } else {
    const where = findOnPath("git", env, host)[0];
    dependencies.push({ label: "git", value: `${firstLine(git.stdout).replace(/^git version /, "")}${where ? `  ${tidy(where)}` : ""}`, status: "ok" });
    const helpers = await run("git", ["config", "--get-all", "credential.helper"]);
    const helperList = helpers.stdout.trim().split("\n").filter(Boolean);
    dependencies.push({ label: "  credential helper", value: helperList.length ? helperList.join(", ") : "none configured" });
  }

  const gh = await run("gh", ["--version"]);
  if (gh.missing || gh.code !== 0) {
    dependencies.push({ label: "gh", value: "not found (needed only for GitHub destinations: https://cli.github.com)", status: "warn" });
  } else {
    const where = findOnPath("gh", env, host)[0];
    dependencies.push({ label: "gh", value: `${firstLine(gh.stdout).replace(/^gh version /, "")}${where ? `  ${tidy(where)}` : ""}`, status: "ok" });
    const auth = await run("gh", ["auth", "status", "--hostname", ghHost]);
    const account = /account (\S+)/.exec(`${auth.stdout}\n${auth.stderr}`)?.[1];
    if (auth.timedOut) {
      dependencies.push({ label: "  auth", value: `could not check ${ghHost} (timed out)`, status: "warn" });
    } else if (auth.code === 0) {
      dependencies.push({ label: "  auth", value: `logged in to ${ghHost}${account ? ` as ${account}` : ""}`, status: "ok" });
    } else {
      dependencies.push({ label: "  auth", value: `not logged in to ${ghHost} (run: gh auth login --hostname ${ghHost})`, status: "warn" });
      problems.push(`gh is not logged in to ${ghHost}; GitHub destinations will fail until you run \`gh auth login\`.`);
    }
    const protocol = await run("gh", ["config", "get", "git_protocol", "--host", ghHost]);
    dependencies.push({ label: "  git_protocol", value: firstLine(protocol.stdout) || "https (default)" });
  }

  const ssh = await run("ssh", ["-V"]);
  dependencies.push(
    ssh.missing
      ? { label: "ssh", value: "not found (needed only for SSH URLs)", status: "warn" }
      : { label: "ssh", value: firstLine(ssh.stderr || ssh.stdout) || "installed", status: "ok" },
  );

  // Configuration from the environment. Token values are never printed.
  const tokenVars = [...new Set([...TOKEN_ENV_VARS.gitlab, ...TOKEN_ENV_VARS.gitea, "GH_TOKEN", "GITHUB_TOKEN"])];
  const setOrNot = (name: string) => (env[name]?.trim() ? "set" : "not set");
  const configuration: Row[] = [
    ...["GH_HOST", "GITLAB_HOST", "GITEA_HOST"].map((name) => ({ label: name, value: env[name] || "not set" })),
    ...tokenVars.map((name) => ({ label: name, value: setOrNot(name) })),
  ];
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY", "no_proxy"]) {
    if (env[name]) configuration.push({ label: name, value: redactUrl(env[name]!) });
  }
  for (const name of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_GLOBAL"]) {
    if (env[name]) configuration.push({ label: name, value: name === "GIT_SSH_COMMAND" ? "set" : env[name]! });
  }

  return {
    title: `git-mirror ${version}`,
    sections: [
      { title: "git-mirror", rows: self },
      { title: "System", rows: system },
      { title: "Dependencies", rows: dependencies },
      { title: "Configuration", rows: configuration },
    ],
    problems,
  };
}

const MARKS: Record<Status, string> = { ok: "✓", warn: "!", error: "✗", info: " " };

export function formatDiagnostics(report: Diagnostics): string {
  const width = Math.max(...report.sections.flatMap((section) => section.rows.map((row) => row.label.length)));
  const lines = [report.title, ""];
  for (const section of report.sections) {
    lines.push(section.title);
    for (const row of section.rows) {
      lines.push(`  ${MARKS[row.status ?? "info"]} ${row.label.padEnd(width)}  ${row.value}`);
    }
    lines.push("");
  }
  if (report.problems.length) {
    lines.push("Problems");
    for (const problem of report.problems) lines.push(`  ✗ ${problem}`);
  } else {
    lines.push("No problems found.");
  }
  lines.push("", "Paste this output into bug reports: https://github.com/hrhv/git-mirror/issues");
  return lines.join("\n");
}
