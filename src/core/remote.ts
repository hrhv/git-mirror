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

/** Extracts `owner/repo` from a GitHub URL on the given host, if it is one. */
export function parseGithubUrl(url: string, host: string): Required<Slug> | undefined {
  const escapedHost = host.replace(/\./g, "\\.");
  const match =
    new RegExp(`^(?:https?|ssh)://(?:[^@/]+@)?${escapedHost}(?::\\d+)?/([^/]+)/([^/]+?)(?:\\.git)?/?$`).exec(url) ??
    new RegExp(`^[\\w.-]+@${escapedHost}:([^/]+)/([^/]+?)(?:\\.git)?/?$`).exec(url);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]! };
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

export type Destination =
  /** A GitHub repository that git-mirror can look up and create via `gh`. */
  | { kind: "github"; owner?: string; repo: string; url?: string }
  /** Any other git remote (another host, a local bare repo). Must already exist. */
  | { kind: "remote"; url: string };

export function parseDestination(input: string, host: string): Destination {
  const value = input.trim();
  if (!value) throw new MirrorError("Destination must not be empty.");

  if (isRemoteUrl(value)) {
    const github = parseGithubUrl(value, host);
    return github ? { kind: "github", ...github, url: value } : { kind: "remote", url: value };
  }
  if (isPathLike(value)) return { kind: "remote", url: value };

  const slug = parseSlug(value);
  if (!slug) {
    throw new MirrorError(
      `Invalid destination "${input}".`,
      "Use `repo`, `owner/repo`, or a full git URL such as git@github.com:owner/repo.git.",
    );
  }
  return { kind: "github", ...slug };
}
