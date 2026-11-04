import { MirrorError } from "./errors.js";
import type { Runner } from "./exec.js";
import type { Protocol } from "./remote.js";

export type Visibility = "private" | "public" | "internal";

/** Thin wrapper over the GitHub CLI (`gh`), which owns authentication. */
export class GitHub {
  constructor(
    private readonly run: Runner,
    readonly host: string,
  ) {}

  private gh(args: string[]) {
    return this.run("gh", args, { env: { GH_HOST: this.host, GH_PROMPT_DISABLED: "1" } });
  }

  async assertAuthenticated(): Promise<void> {
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
  async gitProtocol(): Promise<Protocol> {
    const result = await this.gh(["config", "get", "git_protocol", "--host", this.host]);
    return result.code === 0 && result.stdout.trim() === "ssh" ? "ssh" : "https";
  }

  async repoExists(slug: string): Promise<boolean> {
    const result = await this.gh(["repo", "view", slug, "--json", "name"]);
    if (result.code === 0) return true;
    if (/could not resolve to a repository|not found/i.test(result.stderr)) return false;
    throw new MirrorError(`Could not check whether ${slug} exists.`, result.stderr.trim() || undefined);
  }

  async createRepo(slug: string, visibility: Visibility, description: string): Promise<void> {
    const result = await this.gh(["repo", "create", slug, `--${visibility}`, "--description", description]);
    if (result.code !== 0) {
      throw new MirrorError(`Failed to create ${slug}.`, result.stderr.trim() || undefined);
    }
  }
}
