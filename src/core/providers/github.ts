import { MirrorError } from "../errors.js";
import type { Runner } from "../exec.js";
import { githubUrl, type Protocol } from "../remote.js";
import type { CreateRepoOptions, Provider } from "./types.js";

/** GitHub (and GitHub Enterprise Server) through the GitHub CLI, which owns authentication. */
export class GitHubProvider implements Provider {
  readonly name = "github" as const;
  readonly label = "GitHub";
  readonly nestedNamespaces = false;

  constructor(
    private readonly run: Runner,
    readonly host: string,
  ) {}

  private gh(args: string[]) {
    return this.run("gh", args, { env: { GH_HOST: this.host, GH_PROMPT_DISABLED: "1" } });
  }

  async assertReady(): Promise<void> {
    const result = await this.gh(["auth", "status", "--hostname", this.host]);
    if (result.code !== 0) {
      throw new MirrorError(
        `The GitHub CLI is not logged in to ${this.host}.`,
        `Run \`gh auth login --hostname ${this.host}\` and try again.`,
      );
    }
  }

  async currentUser(): Promise<string> {
    const result = await this.gh(["api", "user", "--jq", ".login"]);
    const login = result.stdout.trim();
    if (result.code !== 0 || !login) {
      throw new MirrorError("Could not determine your GitHub username.", "Pass the destination as owner/repo.");
    }
    return login;
  }

  /** The protocol the user configured in gh (`gh config set git_protocol ssh`), defaulting to https. */
  async defaultProtocol(): Promise<Protocol> {
    const result = await this.gh(["config", "get", "git_protocol", "--host", this.host]);
    return result.code === 0 && result.stdout.trim() === "ssh" ? "ssh" : "https";
  }

  async repoExists(namespace: string, repo: string): Promise<boolean> {
    const slug = `${namespace}/${repo}`;
    const result = await this.gh(["repo", "view", slug, "--json", "name"]);
    if (result.code === 0) return true;
    if (/could not resolve to a repository|not found/i.test(result.stderr)) return false;
    throw new MirrorError(`Could not check whether ${slug} exists.`, result.stderr.trim() || undefined);
  }

  async createRepo(namespace: string, repo: string, { visibility, description }: CreateRepoOptions): Promise<void> {
    const slug = `${namespace}/${repo}`;
    const result = await this.gh(["repo", "create", slug, `--${visibility}`, "--description", description]);
    if (result.code !== 0) {
      throw new MirrorError(`Failed to create ${slug}.`, result.stderr.trim() || undefined);
    }
  }

  repoUrl(namespace: string, repo: string, protocol: Protocol): string {
    return githubUrl(this.host, namespace, repo, protocol);
  }

  /** gh's credential helper (`gh auth setup-git`) or SSH keys handle git auth for GitHub. */
  async gitAuth(): Promise<undefined> {
    return undefined;
  }
}
