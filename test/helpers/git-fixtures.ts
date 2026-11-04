import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRunner, type Runner } from "../../src/core/exec.js";

/** Environment that isolates git from the developer's own config (signing, hooks, default branch...). */
export const isolatedGitEnv: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

/** A real git runner with isolated config plus any extra env (e.g. url.insteadOf rewrites). */
export function gitRunner(extraEnv: Record<string, string> = {}): Runner {
  return (command, args, options) =>
    spawnRunner(command, args, { ...options, env: { ...isolatedGitEnv, ...extraEnv, ...options?.env } });
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitRunner()("git", args, { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function makeTempDir(prefix = "git-mirror-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Creates a work-tree repo with two branches, a lightweight and an annotated tag. */
export async function createSourceRepo(dir: string): Promise<string> {
  await git(dir, "init", "--initial-branch=main", "--quiet");
  await git(dir, "commit", "--allow-empty", "-m", "first", "--quiet");
  await git(dir, "tag", "v1.0.0");
  await git(dir, "checkout", "-b", "feature/login", "--quiet");
  await git(dir, "commit", "--allow-empty", "-m", "feature work", "--quiet");
  await git(dir, "tag", "-a", "v1.1.0", "-m", "release 1.1.0");
  await git(dir, "checkout", "main", "--quiet");
  return dir;
}

export async function createBareRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "--bare", "--initial-branch=main", "--quiet");
  return dir;
}

/** `refname objectname` for every ref, sorted. HEAD is excluded. */
export async function listRefs(repoDir: string): Promise<string[]> {
  const output = await git(repoDir, "for-each-ref", "--format=%(refname) %(objectname)");
  return output.split("\n").filter(Boolean).sort();
}
