import { MirrorError } from "./errors.js";

export type Protocol = "ssh" | "https";

/**
 * scp-like syntax, following git's rule (a colon before any slash): `git@github.com:owner/repo.git`,
 * or an ~/.ssh/config alias such as `myserver:repos/app.git`. A single letter before the colon is a
 * Windows drive (`C:\code`), not a host.
 */
const SCP_LIKE = /^(?:[^@/:\\\s]+@)?[^@/:\\\s]{2,}:(?!\/\/)/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]+$/;

/** True for anything git understands as a remote URL (https://, ssh://, file://, git@host:path). */
export function isRemoteUrl(value: string): boolean {
  return value.includes("://") || SCP_LIKE.test(value);
}

/** True for values that are clearly filesystem paths rather than `owner/repo` shorthand. */
export function isPathLike(value: string): boolean {
  return /^(\/|\.{1,2}(\/|$)|~|[A-Za-z]:[\\/])/.test(value);
}

/** Repository name from a URL or path: `https://host/o/my-repo.git/` -> `my-repo`. */
export function repoNameFromUrl(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/:]/).pop() ?? trimmed;
  return last.replace(/\.git$/, "");
}

export interface Slug {
  owner?: string;
  repo: string;
}

/** Parses `repo` or `owner/repo`. Returns undefined when the value is not shorthand. */
export function parseSlug(value: string): Slug | undefined {
  const parts = value.replace(/\.git$/, "").split("/");
  if (parts.length === 1 && REPO.test(parts[0]!)) return { repo: parts[0]! };
  if (parts.length === 2 && OWNER.test(parts[0]!) && REPO.test(parts[1]!)) {
    return { owner: parts[0]!, repo: parts[1]! };
  }
  return undefined;
}

export interface HostedUrl {
  host: string;
  /** scheme://host[:port] for http(s) URLs; where a web UI and API usually live. */
  origin?: string;
  /** Path segments without a trailing .git: `group/sub/app.git` -> ["group", "sub", "app"]. */
  segments: string[];
}

/** Splits an https, ssh:// or scp-like git URL into host and path. Undefined for file:// and local paths. */
export function parseHostedUrl(url: string): HostedUrl | undefined {
  let host: string;
  let origin: string | undefined;
  let path: string;

  const standard = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.*)$/i.exec(url);
  const scp = standard ? undefined : /^(?:[^@/:\\\s]+@)?([^@/:\\\s]{2,}):(?!\/\/)(.*)$/.exec(url);
  if (standard) {
    const [, scheme, hostname, port, rest] = standard;
    host = hostname!.toLowerCase();
    path = rest!;
    if (/^https?$/i.test(scheme!)) origin = `${scheme!.toLowerCase()}://${host}${port ? `:${port}` : ""}`;
  } else if (scp) {
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else {
    return undefined;
  }

  const segments = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter(Boolean);
  return segments.length > 0 ? { host, origin, segments } : undefined;
}

/** Extracts `owner/repo` from a GitHub URL on the given host, if it is one. */
export function parseGithubUrl(url: string, host: string): Required<Slug> | undefined {
  const parsed = parseHostedUrl(url);
  if (!parsed || parsed.host !== host.toLowerCase() || parsed.segments.length !== 2) return undefined;
  return { owner: parsed.segments[0]!, repo: parsed.segments[1]! };
}

/**
 * Hides credentials in every URL inside `text` (a URL, or git's stderr that quotes one):
 * `https://user:token@host/x` -> `https://user:***@host/x`.
 */
export function redactUrl(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^@/\s'"]+)@/gi, (_match, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(":");
    // A bare `token@host` (common for GitHub PATs) is a secret too; `git@host` is not.
    if (colon === -1) return userinfo === "git" ? `${scheme}git@` : `${scheme}***@`;
    return `${scheme}${userinfo.slice(0, colon)}:***@`;
  });
}

export function githubUrl(host: string, owner: string, repo: string, protocol: Protocol): string {
  return protocol === "ssh" ? `git@${host}:${owner}/${repo}.git` : `https://${host}/${owner}/${repo}.git`;
}

export type DestinationInput =
  /** A git URL; it may or may not be on a provider git-mirror can talk to. */
  | { kind: "url"; url: string }
  /** A filesystem path to an existing (bare) repository. */
  | { kind: "path"; path: string }
  /** `repo`, `owner/repo`, or `group/subgroup/repo` (GitLab), resolved against a provider. */
  | { kind: "shorthand"; namespace?: string; repo: string };

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function parseDestinationInput(input: string): DestinationInput {
  const value = input.trim();
  if (!value) throw new MirrorError("Destination must not be empty.");
  if (isRemoteUrl(value)) return { kind: "url", url: value };
  if (isPathLike(value)) return { kind: "path", path: value };

  const segments = value.replace(/\.git$/, "").split("/");
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    throw new MirrorError(
      `Invalid destination "${input}".`,
      "Use `repo`, `owner/repo`, or a full git URL such as git@github.com:owner/repo.git.",
    );
  }
  const repo = segments.pop()!;
  return segments.length > 0 ? { kind: "shorthand", namespace: segments.join("/"), repo } : { kind: "shorthand", repo };
}
