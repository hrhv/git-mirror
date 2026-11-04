import { MirrorError } from "../errors.js";
import { field, TokenProvider } from "./http.js";
import type { CreateRepoOptions, Provider } from "./types.js";

/** GitLab.com or self-managed GitLab, via the REST API (v4) and a personal/group/project access token. */
export class GitLabProvider extends TokenProvider implements Provider {
  readonly name = "gitlab" as const;
  readonly label = "GitLab";
  readonly nestedNamespaces = true;
  protected readonly requiredScopes = "the `api` scope";

  protected authHeaders() {
    return { "PRIVATE-TOKEN": this.config.token };
  }

  protected async fetchCurrentUser(): Promise<string> {
    const response = await this.request("GET", "/api/v4/user");
    const username = field(response.data, "username");
    if (response.status !== 200 || typeof username !== "string") this.fail("identify the token's user", response);
    return username;
  }

  async repoExists(namespace: string, repo: string): Promise<boolean> {
    const response = await this.request("GET", `/api/v4/projects/${encodeURIComponent(`${namespace}/${repo}`)}`);
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    this.fail(`look up ${namespace}/${repo}`, response);
  }

  async createRepo(namespace: string, repo: string, { visibility, description }: CreateRepoOptions): Promise<void> {
    // Projects in the user's own namespace need no namespace_id; groups and subgroups do.
    const isOwnNamespace = namespace.toLowerCase() === (await this.currentUser()).toLowerCase();
    const namespaceId = isOwnNamespace ? undefined : await this.namespaceId(namespace);

    const response = await this.request("POST", "/api/v4/projects", {
      name: repo,
      path: repo,
      ...(namespaceId === undefined ? {} : { namespace_id: namespaceId }),
      visibility,
      description,
    });
    if (response.status !== 201) this.fail(`create ${namespace}/${repo}`, response);
  }

  private async namespaceId(namespace: string): Promise<number> {
    const response = await this.request("GET", `/api/v4/namespaces/${encodeURIComponent(namespace)}`);
    const id = field(response.data, "id");
    if (response.status === 404) {
      throw new MirrorError(
        `GitLab group ${namespace} was not found on ${this.host}, or the token cannot see it.`,
        "Create the group first, or check the token's access to it.",
      );
    }
    if (response.status !== 200 || typeof id !== "number") this.fail(`look up group ${namespace}`, response);
    return id;
  }
}
