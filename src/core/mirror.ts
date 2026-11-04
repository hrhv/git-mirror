import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MirrorError } from "./errors.js";
import type { Runner } from "./exec.js";
import { Git } from "./git.js";
import { GitHub, type Visibility } from "./github.js";
import type { Logger } from "./logger.js";
import {
  githubUrl,
  isPathLike,
  isRemoteUrl,
  parseDestination,
  parseGithubUrl,
  parseSlug,
  redactUrl,
  repoNameFromUrl,
  type Protocol,
} from "./remote.js";

/** Refs GitHub refuses on push ("deny updating a hidden ref"); stripped unless --keep-pull-refs. */
export const GITHUB_HIDDEN_REF_PREFIXES = ["refs/pull/"];

export interface MirrorOptions {
  source: string;
  destination: string;
  /** GitHub hostname (github.com or a GitHub Enterprise Server host). */
  host: string;
  visibility: Visibility;
  description?: string;
  /** Overrides the protocol from `gh config get git_protocol`. */
  protocol?: Protocol;
  /** Create the destination repo when missing. */
  create: boolean;
  /** Overwrite a destination that already has refs without asking. */
  force: boolean;
  dryRun: boolean;
  keepPullRefs: boolean;
  quiet: boolean;
  cwd: string;
}

export interface MirrorDeps {
  runner: Runner;
  logger: Logger;
  /** Asks the user a yes/no question. Absent when not interactive. */
  confirm?: (question: string) => Promise<boolean>;
  makeTempDir?: () => Promise<string>;
  removeDir?: (dir: string) => Promise<void>;
  isDirectory?: (path: string) => boolean;
}

export interface MirrorResult {
  sourceUrl: string;
  destinationUrl: string;
  /** owner/repo when the destination is on GitHub. */
  slug?: string;
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
  const destination = parseDestination(options.destination, options.host);
  let github: GitHub | undefined;
  let slug: string | undefined;
  let destinationUrl: string;
  let protocol: Protocol = options.protocol ?? "https";

  if (destination.kind === "github") {
    github = new GitHub(runner, options.host);
    await github.assertAuthenticated();
    protocol = options.protocol ?? (await github.gitProtocol());
    const owner = destination.owner ?? (await github.currentUser());
    slug = `${owner}/${destination.repo}`;
    destinationUrl = destination.url ?? githubUrl(options.host, owner, destination.repo, protocol);
  } else {
    // Local paths must be absolute: the push runs from inside the temporary clone.
    destinationUrl = isRemoteUrl(destination.url) ? destination.url : resolve(options.cwd, destination.url);
  }

  // 2. Work out what we are mirroring.
  const source = await resolveSource(options.source, { ...options, protocol }, git, isDirectory);
  if (sameRemote(source.url, destinationUrl, options)) {
    throw new MirrorError("Source and destination are the same repository.");
  }

  logger.info(`Mirroring ${redactUrl(source.url)} → ${redactUrl(destinationUrl)}`);

  // Fail on an unreachable, private or empty source before creating anything on GitHub.
  await git.assertReadableSource(source.url);

  // 3. Make sure the destination exists and that we are allowed to overwrite it.
  let created = false;
  let exists = true;
  if (github && slug) {
    exists = await github.repoExists(slug);
    if (!exists) {
      if (!options.create) {
        throw new MirrorError(`${slug} does not exist.`, "Remove --no-create to have git-mirror create it.");
      }
      const description = options.description ?? `Mirror of ${source.name}`;
      if (options.dryRun) {
        logger.info(`Would create ${options.visibility} repository ${slug}.`);
      } else {
        await github.createRepo(slug, options.visibility, description);
        logger.success(`Created ${options.visibility} repository ${slug}.`);
      }
      created = true;
    } else {
      logger.info(`${slug} already exists.`);
    }
  }

  if (exists && (await git.hasRefs(destinationUrl))) {
    await confirmOverwrite(destinationUrl, options, deps);
  }

  if (options.dryRun) {
    logger.info("Dry run: nothing was cloned or pushed.");
    return { sourceUrl: source.url, destinationUrl, slug, created, dryRun: true };
  }

  // 4. Clone as a bare mirror and push every ref.
  const workDir = await (deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "git-mirror-"))))();
  const removeDir = deps.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  try {
    const repoDir = join(workDir, "repo.git");
    await git.cloneMirror(source.url, repoDir);

    if (!options.keepPullRefs) {
      const removed = await git.deleteRefs(repoDir, GITHUB_HIDDEN_REF_PREFIXES);
      if (removed > 0) logger.info(`Skipping ${removed} pull request ref(s) (use --keep-pull-refs to push them).`);
    }

    await git.pushMirror(repoDir, destinationUrl);
  } finally {
    await removeDir(workDir);
  }

  logger.success(`Mirrored ${source.name} to ${slug ?? redactUrl(destinationUrl)}.`);
  return { sourceUrl: source.url, destinationUrl, slug, created, dryRun: false };
}

async function resolveSource(
  input: string,
  options: Pick<MirrorOptions, "cwd" | "host"> & { protocol: Protocol },
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

/** Compares two remotes, treating the SSH and HTTPS URLs of the same GitHub repo as equal. */
function sameRemote(a: string, b: string, { cwd, host }: Pick<MirrorOptions, "cwd" | "host">): boolean {
  const normalize = (value: string) => {
    const github = parseGithubUrl(value, host);
    if (github) return `github:${github.owner}/${github.repo}`.toLowerCase();
    return (isRemoteUrl(value) ? value : resolve(cwd, value)).replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  };
  return normalize(a) === normalize(b);
}
