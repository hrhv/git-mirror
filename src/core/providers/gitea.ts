import { MirrorError } from "../errors.js";
import { field, TokenProvider } from "./http.js";
import type { CreateRepoOptions, Provider } from "./types.js";

/** Gitea and Forgejo (including Codeberg), via the REST API (v1) and an access token. */
export class GiteaProvider extends TokenProvider implements Provider {
  readonly name = "gitea" as const;
  readonly label = "Gitea";
  readonly nestedNamespaces = false;
  protected readonly requiredScopes = "the `write:repository` and `read:user` scopes (plus `write:organization` for orgs)";

  protected authHeaders() {
    return { Authorization: `token ${this.config.token}` };
  }

  protected async fetchCurrentUser(): Promise<string> {
    const response = await this.request("GET", "/api/v1/user");
    const login = field(response.data, "login");
    if (response.status !== 200 || typeof login !== "string") this.fail("identify the token's user", response);
    return login;
  }

  async repoExists(namespace: string, repo: string): Promise<boolean> {
    const response = await this.request("GET", `/api/v1/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(repo)}`);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    this.fail(`look up ${namespace}/${repo}`, response);
  }

  async createRepo(namespace: string, repo: string, { visibility, description }: CreateRepoOptions): Promise<void> {
    if (visibility === "internal") {
      throw new MirrorError("Gitea repositories cannot be internal.", "Use --visibility private or public.");
    }
    const isOwnNamespace = namespace.toLowerCase() === (await this.currentUser()).toLowerCase();
    const path = isOwnNamespace ? "/api/v1/user/repos" : `/api/v1/orgs/${encodeURIComponent(namespace)}/repos`;

    const response = await this.request("POST", path, { name: repo, description, private: visibility === "private" });
    if (response.status === 404 && !isOwnNamespace) {
      throw new MirrorError(
        `Gitea organization ${namespace} was not found on ${this.host}.`,
        "Create the organization first, or check the name. Repos for other users cannot be created.",
      );
    }
    if (response.status !== 201) this.fail(`create ${namespace}/${repo}`, response);
  }
}
