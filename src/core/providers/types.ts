import type { Protocol } from "../remote.js";

export type ProviderName = "github" | "gitlab" | "gitea";
export const PROVIDER_NAMES: readonly ProviderName[] = ["github", "gitlab", "gitea"];

export type Visibility = "private" | "public" | "internal";

export interface CreateRepoOptions {
  visibility: Visibility;
  description: string;
}

/** `git -c` style config entries, e.g. `{ "http.https://host/.extraHeader": "Authorization: ..." }`. */
export type GitConfig = Record<string, string>;

/**
 * A git hosting service git-mirror can query and create repositories on.
 * `namespace` is the owner: a user or org on GitHub/Gitea, or a (possibly nested) group path on GitLab.
 */
export interface Provider {
  readonly name: ProviderName;
  /** Human-readable name for messages ("GitLab"). */
  readonly label: string;
  readonly host: string;
  /** Whether namespaces may contain slashes (GitLab subgroups). */
  readonly nestedNamespaces: boolean;

  /** Verifies that credentials are present and accepted. Throws a MirrorError with a hint otherwise. */
  assertReady(): Promise<void>;
  /** Username of the authenticated account; the default namespace. */
  currentUser(): Promise<string>;
  /** Protocol for URLs built from shorthand when --protocol is not given. */
  defaultProtocol(): Promise<Protocol>;
  repoExists(namespace: string, repo: string): Promise<boolean>;
  createRepo(namespace: string, repo: string, options: CreateRepoOptions): Promise<void>;
  repoUrl(namespace: string, repo: string, protocol: Protocol): string;
  /** git config that authenticates git itself against `url`, when the provider can supply it. */
  gitAuth(url: string): Promise<GitConfig | undefined>;
}
