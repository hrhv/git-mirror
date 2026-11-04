import { MirrorError } from "../errors.js";
import type { Runner } from "../exec.js";
import { GiteaProvider } from "./gitea.js";
import { GitHubProvider } from "./github.js";
import { GitLabProvider } from "./gitlab.js";
import type { Fetch } from "./http.js";
import type { Provider, ProviderName } from "./types.js";

export type { Provider, ProviderName, Visibility, GitConfig } from "./types.js";
export { PROVIDER_NAMES } from "./types.js";

export type Env = Record<string, string | undefined>;

const LABELS: Record<ProviderName, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea" };

/** Env vars checked for an API token, most specific first. GitHub uses `gh`'s own login instead. */
export const TOKEN_ENV_VARS: Record<Exclude<ProviderName, "github">, string[]> = {
  gitlab: ["GIT_MIRROR_TOKEN", "GITLAB_TOKEN"],
  gitea: ["GIT_MIRROR_TOKEN", "GITEA_TOKEN", "FORGEJO_TOKEN"],
};

/** `GITLAB_HOST=https://gitlab.example.com/` -> `gitlab.example.com` (glab accepts either form). */
function hostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

export function githubHost(env: Env, explicitHost?: string): string {
  return (explicitHost ?? hostname(env.GH_HOST) ?? "github.com").toLowerCase();
}

/** Host used for shorthand destinations (`owner/repo`) of each provider. */
export function defaultHost(name: ProviderName, env: Env): string | undefined {
  if (name === "github") return githubHost(env);
  if (name === "gitlab") return hostname(env.GITLAB_HOST) ?? "gitlab.com";
  return hostname(env.GITEA_HOST);
}

/**
 * Recognises well-known hosts in destination URLs. Self-hosted GitLab/Gitea servers can't be told apart
 * from a URL alone, so those need --provider (or GITLAB_HOST / GITEA_HOST).
 */
export function detectProvider(host: string, env: Env, githubHostname: string): ProviderName | undefined {
  if (host === githubHostname || host === "github.com") return "github";
  if (host === "gitlab.com" || host === hostname(env.GITLAB_HOST)) return "gitlab";
  if (host === "codeberg.org" || host === hostname(env.GITEA_HOST)) return "gitea";
  return undefined;
}

export function findToken(name: Exclude<ProviderName, "github">, env: Env): { token: string; source: string } | undefined {
  for (const variable of TOKEN_ENV_VARS[name]) {
    const token = env[variable]?.trim();
    if (token) return { token, source: variable };
  }
  return undefined;
}

export function missingTokenError(name: Exclude<ProviderName, "github">, host: string): MirrorError {
  const vars = TOKEN_ENV_VARS[name];
  const scopes = name === "gitlab" ? "the `api` scope" : "`write:repository` and `read:user`";
  return new MirrorError(
    `No ${LABELS[name]} token found for ${host}.`,
    `Set ${vars.slice(1).join(" or ")} (or ${vars[0]}) to an access token with ${scopes}.`,
  );
}

export interface CreateProviderOptions {
  name: ProviderName;
  host: string;
  /** API/web origin override (--api-url). Defaults to the URL's origin or https://<host>. */
  baseUrl?: string;
  env: Env;
  runner: Runner;
  fetch?: Fetch;
}

/** Builds a provider, or throws when a token-based provider has no token. */
export function createProvider({ name, host, baseUrl, env, runner, fetch }: CreateProviderOptions): Provider {
  if (name === "github") return new GitHubProvider(runner, host);

  const credentials = findToken(name, env);
  if (!credentials) throw missingTokenError(name, host);

  const config = {
    host,
    baseUrl: (baseUrl ?? `https://${host}`).replace(/\/+$/, ""),
    token: credentials.token,
    tokenSource: credentials.source,
    fetch: fetch ?? globalThis.fetch,
  };
  return name === "gitlab" ? new GitLabProvider(config) : new GiteaProvider(config);
}

export function providerLabel(name: ProviderName): string {
  return LABELS[name];
}
