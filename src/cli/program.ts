import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { MirrorError } from "../core/errors.js";
import { spawnRunner, type Runner } from "../core/exec.js";
import { createConsoleLogger, type Logger } from "../core/logger.js";
import { mirror, type MirrorDeps, type MirrorOptions } from "../core/mirror.js";

export interface CliDeps {
  runner?: Runner;
  logger?: Logger;
  confirm?: MirrorDeps["confirm"];
  /** Whether stdin is an interactive terminal (enables the overwrite prompt). */
  interactive?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Where commander writes help/usage output. */
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

const EXAMPLES = `
Examples:
  $ git-mirror . my-backup                         mirror the current repo to <you>/my-backup
  $ git-mirror vercel/next.js my-org/next-mirror   mirror a GitHub repo into an organization
  $ git-mirror https://gitlab.com/group/app.git app --public
  $ git-mirror ./app git@bitbucket.org:me/app.git  push to any existing git remote

The destination repo is created (private by default) through the GitHub CLI if it is missing.
Mirroring replaces every branch and tag in the destination, so existing repos need --force or confirmation.`;

export function createProgram(deps: CliDeps = {}, onRun: (options: MirrorOptions) => Promise<void>): Command {
  const env = deps.env ?? process.env;

  return new Command()
    .name("git-mirror")
    .description(pkg.description)
    .version(pkg.version, "-v, --version")
    .argument("<source>", "local path, git URL, or owner/repo on GitHub")
    .argument("<destination>", "repo or owner/repo on GitHub, or any git remote URL")
    .addOption(
      new Option("--visibility <visibility>", "visibility of a newly created repo")
        .choices(["private", "public", "internal"])
        .default("private"),
    )
    .addOption(new Option("--public", "shorthand for --visibility public").implies({ visibility: "public" }))
    .option("-d, --description <text>", 'description for a newly created repo (default: "Mirror of <source>")')
    .option("--host <hostname>", "GitHub hostname, for GitHub Enterprise Server", env.GH_HOST || "github.com")
    .addOption(
      new Option("--protocol <protocol>", "protocol for GitHub URLs (default: your `gh` git_protocol setting)").choices([
        "ssh",
        "https",
      ]),
    )
    .option("--no-create", "fail instead of creating a missing destination repo")
    .option("-f, --force", "overwrite a destination that already has content without asking", false)
    .option("-n, --dry-run", "show what would happen without creating or pushing anything", false)
    .option("--keep-pull-refs", "also push refs/pull/* (GitHub rejects these, so only useful for other hosts)", false)
    .option("-q, --quiet", "only print warnings and errors", false)
    .addHelpText("after", EXAMPLES)
    .showHelpAfterError("(run git-mirror --help for usage)")
    .configureOutput({
      ...(deps.writeOut && { writeOut: deps.writeOut }),
      ...(deps.writeErr && { writeErr: deps.writeErr, outputError: (text, write) => write(text) }),
    })
    .exitOverride()
    .action(async (source: string, destination: string, opts) => {
      await onRun({
        source,
        destination,
        host: opts.host,
        visibility: opts.visibility,
        description: opts.description,
        protocol: opts.protocol,
        create: opts.create,
        force: opts.force,
        dryRun: opts.dryRun,
        keepPullRefs: opts.keepPullRefs,
        quiet: opts.quiet,
        cwd: deps.cwd ?? process.cwd(),
      });
    });
}

/** Parses argv (without the node/script prefix), runs the mirror, and returns the process exit code. */
export async function run(args: string[], deps: CliDeps = {}): Promise<number> {
  let logger = deps.logger ?? createConsoleLogger();

  const program = createProgram(deps, async (options) => {
    if (!deps.logger) logger = createConsoleLogger({ quiet: options.quiet });
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
    await mirror(options, {
      runner: deps.runner ?? spawnRunner,
      logger,
      confirm: deps.confirm ?? (interactive ? askYesNo : undefined),
    });
  });

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version exit with code 0; usage errors were already printed by commander.
      return error.exitCode;
    }
    if (error instanceof MirrorError) {
      logger.error(error.message);
      if (error.hint) logger.error(error.hint);
      return 1;
    }
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
