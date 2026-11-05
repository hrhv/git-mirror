import { createInterface } from "node:readline/promises";
import { Command, CommanderError, Option } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { collectDiagnostics, formatDiagnostics, type HostInfo } from "../core/diagnostics.js";
import { MirrorError } from "../core/errors.js";
import { spawnRunner, type Runner } from "../core/exec.js";
import { createConsoleLogger, type Logger } from "../core/logger.js";
import { mirror, type MirrorDeps, type MirrorOptions } from "../core/mirror.js";
import type { Fetch } from "../core/providers/http.js";
import { PROVIDER_NAMES } from "../core/providers/index.js";

export interface CliDeps {
  runner?: Runner;
  logger?: Logger;
  confirm?: MirrorDeps["confirm"];
  /** Whether stdin is an interactive terminal (enables the overwrite prompt). */
  interactive?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** Machine facts for `-v` (tests inject these). */
  host?: HostInfo;
  /** Where commander writes help/usage output. */
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}

const EXAMPLES = `
Examples:
  $ git-mirror . my-backup                         mirror the current repo to <you>/my-backup on GitHub
  $ git-mirror vercel/next.js my-org/next-mirror   mirror a GitHub repo into an organization
  $ git-mirror https://gitlab.com/group/app.git app --public
  $ git-mirror . team/app --provider gitlab --host gitlab.example.com
  $ git-mirror . https://gitea.example.com/me/app.git --provider gitea
  $ git-mirror ./app git@bitbucket.org:me/app.git  push to any existing git remote

Missing repos are created (private by default): on GitHub through the GitHub CLI (gh), on
GitLab and Gitea/Forgejo through their API using a token from GITLAB_TOKEN / GITEA_TOKEN
(or GIT_MIRROR_TOKEN). Other remotes are pushed to as-is and must already exist.
Mirroring replaces every branch and tag in the destination, so existing repos need --force or confirmation.`;

export function createProgram(deps: CliDeps = {}, onRun: (options: MirrorOptions) => Promise<void>): Command {
  const env = deps.env ?? process.env;

  return new Command()
    .name("git-mirror")
    .description(pkg.description)
    .version(pkg.version, "-V, --version", "output the version number")
    // Handled in run() before parsing, so it works without <source> and <destination>.
    .option("-v, --info", "show version, platform and dependency details (include this in bug reports)")
    .argument("<source>", "local path, git URL (https or ssh), or owner/repo on GitHub")
    .argument("<destination>", "repo, owner/repo (or group/subgroup/repo on GitLab), or any git URL or path")
    .addOption(
      new Option("--visibility <visibility>", "visibility of a newly created repo")
        .choices(["private", "public", "internal"])
        .default("private"),
    )
    .addOption(new Option("--public", "shorthand for --visibility public").implies({ visibility: "public" }))
    .option("-d, --description <text>", 'description for a newly created repo (default: "Mirror of <source>")')
    .addOption(
      new Option("--provider <provider>", "hosting provider of the destination (default: detected from the URL, else github)").choices(
        PROVIDER_NAMES,
      ),
    )
    .option(
      "--host <hostname>",
      "host for shorthand destinations (default: $GH_HOST or github.com; with --provider gitlab: $GITLAB_HOST or gitlab.com; gitea: $GITEA_HOST)",
    )
    .option("--api-url <url>", "GitLab/Gitea API origin, when it differs from https://<host> (e.g. http://gitea.local:3000)")
    .addOption(
      new Option(
        "--protocol <protocol>",
        "protocol for URLs built from shorthand (default: your `gh` git_protocol setting on GitHub, https elsewhere)",
      ).choices(["ssh", "https"]),
    )
    .option("--no-create", "fail instead of creating a missing destination repo")
    .option("-f, --force", "overwrite a destination that already has content without asking", false)
    .option("-n, --dry-run", "show what would happen without creating or pushing anything", false)
    .option(
      "--keep-host-refs",
      "also push host-generated refs (refs/pull/*, refs/merge-requests/*, ...); most hosts reject these",
      false,
    )
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
        provider: opts.provider,
        host: opts.host,
        apiUrl: opts.apiUrl,
        visibility: opts.visibility,
        description: opts.description,
        protocol: opts.protocol,
        create: opts.create,
        force: opts.force,
        dryRun: opts.dryRun,
        keepHostRefs: opts.keepHostRefs,
        quiet: opts.quiet,
        cwd: deps.cwd ?? process.cwd(),
        env,
      });
    });
}

/** Parses argv (without the node/script prefix), runs the mirror, and returns the process exit code. */
export async function run(args: string[], deps: CliDeps = {}): Promise<number> {
  let logger = deps.logger ?? createConsoleLogger();

  // `git-mirror -v` / `--info`: diagnostics only. Arguments after `--` are positional, never flags.
  const flags = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (flags.includes("-v") || flags.includes("--info")) {
    const report = await collectDiagnostics({
      version: pkg.version,
      runner: deps.runner ?? spawnRunner,
      env: deps.env ?? process.env,
      host: deps.host,
    });
    (deps.writeOut ?? ((text: string) => process.stdout.write(text)))(`${formatDiagnostics(report)}\n`);
    return 0;
  }

  const program = createProgram(deps, async (options) => {
    if (!deps.logger) logger = createConsoleLogger({ quiet: options.quiet });
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
    await mirror(options, {
      runner: deps.runner ?? spawnRunner,
      logger,
      confirm: deps.confirm ?? (interactive ? askYesNo : undefined),
      fetch: deps.fetch,
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
