import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { MirrorError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  /** Extra environment variables, merged over process.env. */
  env?: Record<string, string>;
  /** Data written to the child's stdin. */
  input?: string;
  /** Pass stdout/stderr through to the terminal instead of capturing them. */
  stream?: boolean;
  /**
   * git config for this command only, passed via GIT_CONFIG_COUNT/KEY/VALUE env vars (appended to any
   * already set) so values such as auth headers never show up in the process list.
   */
  gitConfig?: Record<string, string>;
}

/** Appends `config` to the GIT_CONFIG_* entries already present in `env`. */
export function withGitConfig(env: Record<string, string | undefined>, config: Record<string, string> = {}) {
  const result = { ...env };
  let count = Number(result.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of Object.entries(config)) {
    result[`GIT_CONFIG_KEY_${count}`] = key;
    result[`GIT_CONFIG_VALUE_${count}`] = value;
    count++;
  }
  if (count > 0) result.GIT_CONFIG_COUNT = String(count);
  return result;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command. Never rejects on a non-zero exit code; check `code`. */
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withGitConfig({ ...process.env, ...options.env }, options.gitConfig),
      stdio: [options.input === undefined ? "ignore" : "pipe", options.stream ? "inherit" : "pipe", options.stream ? "inherit" : "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && options.cwd && !existsSync(options.cwd)) {
        reject(new MirrorError(`Working directory ${options.cwd} does not exist.`));
      } else if (error.code === "ENOENT") {
        reject(new MirrorError(`\`${command}\` was not found on your PATH.`, installHint(command)));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });

function installHint(command: string): string | undefined {
  if (command === "gh") return "Install the GitHub CLI from https://cli.github.com and run `gh auth login`.";
  if (command === "git") return "Install git from https://git-scm.com/downloads.";
  return undefined;
}
