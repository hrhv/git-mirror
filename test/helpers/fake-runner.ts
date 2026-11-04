import type { RunOptions, RunResult, Runner } from "../../src/core/exec.js";
import type { Logger } from "../../src/core/logger.js";

export interface Call {
  command: string;
  args: string[];
  options?: RunOptions;
}

export type Handler = (args: string[], options?: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>> | undefined;

export const ok = (stdout = ""): Partial<RunResult> => ({ code: 0, stdout });
export const fail = (stderr = "", code = 1): Partial<RunResult> => ({ code, stderr });

/**
 * A runner that answers commands from handlers keyed by command name ("gh", "git").
 * Unhandled commands go to `fallback`, or fail loudly so tests never hit the real tools by accident.
 */
export function createFakeRunner(handlers: Record<string, Handler>, fallback?: Runner) {
  const calls: Call[] = [];
  const runner: Runner = async (command, args, options) => {
    calls.push({ command, args, options });
    const result = await handlers[command]?.(args, options);
    if (result) return { code: 0, stdout: "", stderr: "", ...result };
    if (fallback) return fallback(command, args, options);
    throw new Error(`Unexpected command in test: ${command} ${args.join(" ")}`);
  };
  const commands = (command: string) => calls.filter((call) => call.command === command).map((call) => call.args.join(" "));
  return { runner, calls, commands };
}

export interface FakeGhState {
  authenticated?: boolean;
  user?: string;
  protocol?: "ssh" | "https";
  /** owner/repo slugs that exist. */
  repos?: Set<string>;
  onCreate?: (slug: string) => void | Promise<void>;
}

/** Simulates the subset of `gh` that git-mirror uses. */
export function fakeGh(state: FakeGhState = {}): Handler {
  const repos = state.repos ?? new Set<string>();
  return async (args) => {
    const [group, sub] = args;
    if (group === "auth" && sub === "status") return state.authenticated === false ? fail("not logged in") : ok();
    if (group === "api" && sub === "user") return ok(`${state.user ?? "octocat"}\n`);
    if (group === "config" && sub === "get") return ok(`${state.protocol ?? "https"}\n`);
    if (group === "repo" && sub === "view") {
      return repos.has(args[2]!) ? ok("{}") : fail(`GraphQL: Could not resolve to a Repository with the name '${args[2]}'.`);
    }
    if (group === "repo" && sub === "create") {
      repos.add(args[2]!);
      await state.onCreate?.(args[2]!);
      return ok();
    }
    return fail(`fake gh: unsupported ${args.join(" ")}`);
  };
}

export function createMemoryLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(`info: ${message}`),
    success: (message) => lines.push(`success: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
  return { logger, lines, text: () => lines.join("\n") };
}
