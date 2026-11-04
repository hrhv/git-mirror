import { resolve } from "node:path";
import { MirrorError } from "./errors.js";
import type { Runner } from "./exec.js";
import type { Logger } from "./logger.js";
import {
  createProvider,
  defaultHost,
  detectProvider,
  findToken,
  githubHost,
  providerLabel,
  TOKEN_ENV_VARS,
  type Env,
  type GitConfig,
  type Provider,
  type ProviderName,
} from "./providers/index.js";
import type { Fetch } from "./providers/http.js";
import { parseDestinationInput, parseHostedUrl, type Protocol } from "./remote.js";

export interface DestinationOptions {
  destination: string;
  /** Forces the hosting provider (otherwise detected from well-known hosts). */
  provider?: ProviderName;
  /** Host for shorthand destinations. Without --provider it is the GitHub (Enterprise) host. */
  host?: string;
  /** API origin override for GitLab/Gitea. */
  apiUrl?: string;
  protocol?: Protocol;
  cwd: string;
  env: Env;
}

export type ResolvedDestination =
  /** A repo on a provider git-mirror can look up and create. */
  | {
      kind: "hosted";
      provider: Provider;
      namespace: string;
      repo: string;
      url: string;
      /** Protocol of `url`, reused for owner/repo shorthand sources. */
      protocol: Protocol;
      gitConfig?: GitConfig;
    }
  /** Any other git remote: pushed to as-is and must already exist. */
  | { kind: "remote"; url: string };

export async function resolveDestination(
  options: DestinationOptions,
  deps: { runner: Runner; logger: Logger; fetch?: Fetch },
): Promise<ResolvedDestination> {
  const input = parseDestinationInput(options.destination);
  // Without --provider, --host keeps its original meaning: the GitHub (Enterprise) host.
  const ghHost = githubHost(options.env, options.provider ? undefined : options.host);
  const make = (name: ProviderName, host: string, baseUrl?: string) =>
    createProvider({ name, host, baseUrl: options.apiUrl ?? baseUrl, env: options.env, runner: deps.runner, fetch: deps.fetch });

  if (input.kind === "path") {
    // Local paths must be absolute: the push runs from inside the temporary clone.
    return { kind: "remote", url: resolve(options.cwd, input.path) };
  }

  if (input.kind === "url") {
    const parsed = parseHostedUrl(input.url);
    const name = options.provider ?? (parsed && detectProvider(parsed.host, options.env, ghHost));
    if (!parsed || !name) return { kind: "remote", url: input.url };

    // URLs always name the namespace: owner/repo, or group/.../repo on GitLab.
    const depth = parsed.segments.length;
    if (depth < 2 || (depth > 2 && name !== "gitlab")) {
      if (options.provider) throw new MirrorError(`${input.url} is not a ${providerLabel(name)} repository URL.`);
      return { kind: "remote", url: input.url };
    }

    // A detected (not requested) GitLab/Gitea host without a token still works as a plain remote.
    if (name !== "github" && !options.provider && !findToken(name, options.env)) {
      deps.logger.info(
        `${input.url} looks like ${providerLabel(name)}. Set ${TOKEN_ENV_VARS[name][1]} to let git-mirror create it when missing.`,
      );
      return { kind: "remote", url: input.url };
    }

    const provider = make(name, parsed.host, parsed.origin);
    await provider.assertReady();
    const repo = parsed.segments.pop()!;
    const protocol: Protocol = parsed.origin ? "https" : "ssh";
    return {
      kind: "hosted",
      provider,
      namespace: parsed.segments.join("/"),
      repo,
      url: input.url,
      protocol,
      gitConfig: await provider.gitAuth(input.url),
    };
  }

  // Shorthand: repo, owner/repo, or group/subgroup/repo.
  const name = options.provider ?? "github";
  const host = name === "github" ? ghHost : (options.host?.toLowerCase() ?? defaultHost(name, options.env));
  if (!host) {
    throw new MirrorError(
      `--host is required for ${providerLabel(name)} shorthand destinations.`,
      `Pass --host git.example.com, set ${name.toUpperCase()}_HOST, or use a full URL as the destination.`,
    );
  }

  if (input.namespace?.includes("/") && name !== "gitlab") {
    throw new MirrorError(
      `Invalid destination "${options.destination}" for ${providerLabel(name)}.`,
      name === "github"
        ? "Use `repo`, `owner/repo`, or a full git URL. For GitLab subgroups, pass --provider gitlab."
        : "Use `repo` or `owner/repo`.",
    );
  }

  const provider = make(name, host);
  await provider.assertReady();
  const protocol = options.protocol ?? (await provider.defaultProtocol());
  const namespace = input.namespace ?? (await provider.currentUser());
  const url = provider.repoUrl(namespace, input.repo, protocol);
  return { kind: "hosted", provider, namespace, repo: input.repo, url, protocol, gitConfig: await provider.gitAuth(url) };
}
