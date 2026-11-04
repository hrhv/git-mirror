import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MirrorError } from "./errors.js";
import type { Runner } from "./exec.js";
import { Git } from "./git.js";
import { resolveDestination } from "./destination.js";
import type { Logger } from "./logger.js";
import type { Fetch } from "./providers/http.js";
import { githubHost, type Env, type ProviderName, type Visibility } from "./providers/index.js";
import { githubUrl, isPathLike, isRemoteUrl, parseHostedUrl, parseSlug, redactUrl, repoNameFromUrl, type Protocol } from "./remote.js";

/**
 * Refs that hosts generate for pull/merge requests and CI. They are not project history, and hosts reject
 * pushes that include them ("deny updating a hidden ref"), so they are stripped unless --keep-host-refs.
 */
export const HOST_REF_PREFIXES = [
  "refs/pull/", // GitHub, Gitea, Forgejo
  "refs/merge-requests/", // GitLab
  "refs/pipelines/",
  "refs/keep-around/",
  "refs/environments/",
];

export interface MirrorOptions {
  source: string;
  destination: string;
  /** Hosting provider of the destination; detected from well-known hosts when omitted. */
  provider?: ProviderName;
  /**
   * Host for shorthand destinations (`owner/repo`). Without `provider` this is the GitHub (Enterprise)
   * host; defaults come from GH_HOST / GITLAB_HOST / GITEA_HOST.
   */
  host?: string;
  /** API origin for GitLab/Gitea when it differs from https://<host>. */
  apiUrl?: string;
  visibility: Visibility;
  description?: string;
  /** Protocol for URLs built from shorthand; defaults to gh's git_protocol (GitHub) or https (token providers). */
  protocol?: Protocol;
  /** Create the destination repo when missing. */
  create: boolean;
  /** Overwrite a destination that already has refs without asking. */
  force: boolean;
  dryRun: boolean;
  keepHostRefs: boolean;
  quiet: boolean;
  cwd: string;
  /** Environment for tokens and default hosts (the CLI passes process.env). */
  env: Env;
}

export interface MirrorDeps {
  runner: Runner;
  logger: Logger;
  /** Asks the user a yes/no question. Absent when not interactive. */
  confirm?: (question: string) => Promise<boolean>;
  makeTempDir?: () => Promise<string>;
  removeDir?: (dir: string) => Promise<void>;
  isDirectory?: (path: string) => boolean;
  /** HTTP client for the GitLab/Gitea APIs. */
  fetch?: Fetch;
}

export interface MirrorResult {
  sourceUrl: string;
  destinationUrl: string;
  /** namespace/repo when the destination is on a provider git-mirror manages. */
  slug?: string;
  provider?: ProviderName;
  created: boolean;
  dryRun: boolean;
}

interface ResolvedSource {
  url: string;
  name: string;
}

const defaultIsDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory();

export async function mirror(options: MirrorOptions, deps: MirrorDeps): Promise<MirrorResult> {
  const { runner, logger } = deps;
  const git = new Git(runner, options.quiet);
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;

  await git.assertInstalled();

  // 1. Work out where we are pushing to.
  const destination = await resolveDestination(options, { runner, logger, fetch: deps.fetch });
  const destinationUrl = destination.url;
  const hosted = destination.kind === "hosted" ? destination : undefined;
  const slug = hosted && `${hosted.namespace}/${hosted.repo}`;
  const gitConfig = hosted?.gitConfig;

  // 2. Work out what we are mirroring.
  const ghHost = githubHost(options.env, options.provider ? undefined : options.host);
  const sourceProtocol = hosted?.provider.name === "github" ? hosted.protocol : (options.protocol ?? "https");
  const source = await resolveSource(options.source, { cwd: options.cwd, host: ghHost, protocol: sourceProtocol }, git, isDirectory);
  if (sameRemote(source.url, destinationUrl, options.cwd)) {
    throw new MirrorError("Source and destination are the same repository.");
  }

  logger.info(`Mirroring ${redactUrl(source.url)} → ${redactUrl(destinationUrl)}`);

  // Fail on an unreachable, private or empty source before creating anything.
  await git.assertReadableSource(source.url);

  // 3. Make sure the destination exists and that we are allowed to overwrite it.
  let created = false;
  let exists = true;
  if (hosted && slug) {
    const { provider } = hosted;
    const where = `${slug} on ${provider.host}`;
    exists = await provider.repoExists(hosted.namespace, hosted.repo);
    if (!exists) {
      if (!options.create) {
        throw new MirrorError(`${where} does not exist.`, "Remove --no-create to have git-mirror create it.");
      }
      const description = options.description ?? `Mirror of ${source.name}`;
      if (options.dryRun) {
        logger.info(`Would create ${options.visibility} repository ${where}.`);
      } else {
        await provider.createRepo(hosted.namespace, hosted.repo, { visibility: options.visibility, description });
        logger.success(`Created ${options.visibility} repository ${where}.`);
      }
      created = true;
    } else {
      logger.info(`${where} already exists.`);
    }
  }

  const missingRepoHint = hosted
    ? undefined
    : "If the repository does not exist yet, create it first, or pass --provider gitlab|gitea (with an access token) so git-mirror can create it.";
  if (exists && (await git.hasRefs(destinationUrl, { gitConfig, hint: missingRepoHint }))) {
    await confirmOverwrite(destinationUrl, options, deps);
  }

  if (options.dryRun) {
    logger.info("Dry run: nothing was cloned or pushed.");
    return { sourceUrl: source.url, destinationUrl, slug, provider: hosted?.provider.name, created, dryRun: true };
  }

  // 4. Clone as a bare mirror and push every ref.
  const workDir = await (deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "git-mirror-"))))();
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  try {
    const repoDir = join(workDir, "repo.git");
    await git.cloneMirror(source.url, repoDir);

    if (!options.keepHostRefs) {
      const removed = await git.deleteRefs(repoDir, HOST_REF_PREFIXES);
      if (removed > 0) {
        logger.info(`Skipping ${removed} pull/merge request ref(s) created by the source host (use --keep-host-refs to push them).`);
      }
    }

    await git.pushMirror(repoDir, destinationUrl, gitConfig);
  } finally {
    await removeDir(workDir);
  }

  logger.success(`Mirrored ${source.name} to ${slug ?? redactUrl(destinationUrl)}.`);
  return { sourceUrl: source.url, destinationUrl, slug, provider: hosted?.provider.name, created, dryRun: false };
}

async function resolveSource(
  input: string,
  options: { cwd: string; host: string; protocol: Protocol },
  git: Git,
  isDirectory: (path: string) => boolean,
): Promise<ResolvedSource> {
  const value = input.trim();
  if (!value) throw new MirrorError("Source must not be empty.");

  // A local directory always wins, so `./owner/repo` style paths are never mistaken for GitHub shorthand.
  const localPath = resolve(options.cwd, value);
  if (!isRemoteUrl(value) && isDirectory(localPath)) {
    const name = await git.repoName(localPath);
    if (!name) throw new MirrorError(`${localPath} is not a git repository.`);
    return { url: localPath, name };
  }

  if (isRemoteUrl(value)) return { url: value, name: repoNameFromUrl(value) };

  if (isPathLike(value)) throw new MirrorError(`Source path ${localPath} does not exist.`);

  const slug = parseSlug(value);
  if (slug?.owner) {
    return { url: githubUrl(options.host, slug.owner, slug.repo, options.protocol), name: slug.repo };
  }

  throw new MirrorError(
    `Cannot find source "${input}".`,
    "Use a local path, a git URL, or owner/repo for a GitHub repository.",
  );
}

async function confirmOverwrite(url: string, options: MirrorOptions, deps: MirrorDeps): Promise<void> {
  if (options.force) return;
  const warning = `${redactUrl(url)} already has content. Mirroring replaces all of its branches and tags and deletes any that are not in the source.`;

  if (options.dryRun) {
    deps.logger.warn(`${warning} A real run would need --force or confirmation.`);
    return;
  }
  if (!deps.confirm) {
    throw new MirrorError(warning, "Re-run with --force to overwrite it.");
  }
  deps.logger.warn(warning);
  if (!(await deps.confirm("Overwrite it?"))) throw new MirrorError("Aborted.");
}

/** Compares two remotes, treating the SSH and HTTPS URLs of the same hosted repo as equal. */
function sameRemote(a: string, b: string, cwd: string): boolean {
  const normalize = (value: string) => {
    const hosted = parseHostedUrl(value);
    if (hosted) return `${hosted.host}/${hosted.segments.join("/")}`.toLowerCase();
    return (isRemoteUrl(value) ? value : resolve(cwd, value)).replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  };
  return normalize(a) === normalize(b);
}
