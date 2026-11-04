import { describe, expect, it } from "vitest";
import { withGitConfig } from "../../src/core/exec.js";
import { GiteaProvider } from "../../src/core/providers/gitea.js";
import { GitLabProvider } from "../../src/core/providers/gitlab.js";
import { createProvider, defaultHost, detectProvider, findToken } from "../../src/core/providers/index.js";
import { createFakeFetch, fakeGitLab, type Routes } from "../helpers/fake-api.js";

const config = (fetch: ReturnType<typeof createFakeFetch>["fetch"], baseUrl = "https://git.example.com") => ({
  host: "git.example.com",
  baseUrl,
  token: "tok-123",
  tokenSource: "GITLAB_TOKEN",
  fetch,
});

const gitlab = (routes: Routes) => {
  const api = createFakeFetch(routes);
  return { ...api, provider: new GitLabProvider(config(api.fetch)) };
};
const gitea = (routes: Routes) => {
  const api = createFakeFetch(routes);
  return { ...api, provider: new GiteaProvider({ ...config(api.fetch), tokenSource: "GITEA_TOKEN" }) };
};

describe("GitLabProvider", () => {
  it("authenticates with PRIVATE-TOKEN and caches the current user", async () => {
    const t = gitlab({ "GET /api/v4/user": { status: 200, body: { username: "jane" } } });
    expect(await t.provider.currentUser()).toBe("jane");
    await t.provider.assertReady();
    expect(t.calls()).toEqual(["GET /api/v4/user"]);
    expect(t.requests[0]!.headers["PRIVATE-TOKEN"]).toBe("tok-123");
  });

  it("looks projects up by URL-encoded full path, including subgroups", async () => {
    const t = gitlab({ "GET /api/v4/projects/team%2Fsub%2Fapp": { status: 200, body: {} } });
    expect(await t.provider.repoExists("team/sub", "app")).toBe(true);
    expect(await t.provider.repoExists("team/sub", "other")).toBe(false);
  });

  it("creates a project in the user's own namespace without a namespace_id", async () => {
    const t = fakeGitLab({ user: "jane" });
    const provider = new GitLabProvider(config(t.fetch));
    await provider.createRepo("jane", "app", { visibility: "private", description: "Mirror of app" });
    expect(t.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v4/projects",
      body: { name: "app", path: "app", visibility: "private", description: "Mirror of app" },
    });
    expect(t.requests.at(-1)!.body).not.toHaveProperty("namespace_id");
  });

  it("creates a project in a subgroup by resolving its namespace_id, with internal visibility", async () => {
    const t = fakeGitLab({ user: "jane", groups: { "team/sub": 42 } });
    const provider = new GitLabProvider(config(t.fetch));
    await provider.createRepo("team/sub", "app", { visibility: "internal", description: "d" });
    expect(t.calls()).toContain("GET /api/v4/namespaces/team%2Fsub");
    expect(t.requests.at(-1)!.body).toMatchObject({ namespace_id: 42, visibility: "internal" });
    expect(t.projects.has("team/sub/app")).toBe(true);
  });

  it("explains a missing group", async () => {
    const t = fakeGitLab({ user: "jane", groups: {} });
    const provider = new GitLabProvider(config(t.fetch));
    await expect(provider.createRepo("nope", "app", { visibility: "private", description: "d" })).rejects.toThrow(
      "GitLab group nope was not found on git.example.com, or the token cannot see it.",
    );
  });

  it("surfaces GitLab validation errors", async () => {
    const t = gitlab({
      "GET /api/v4/user": { status: 200, body: { username: "jane" } },
      "POST /api/v4/projects": { status: 400, body: { message: { name: ["has already been taken"] } } },
    });
    await expect(t.provider.createRepo("jane", "app", { visibility: "private", description: "d" })).rejects.toMatchObject({
      message: "GitLab could not create jane/app (HTTP 400).",
      hint: "name has already been taken",
    });
  });

  it("maps 401 and 403 to token and scope problems", async () => {
    const rejected = gitlab({ "GET /api/v4/user": { status: 401, body: { message: "401 Unauthorized" } } });
    await expect(rejected.provider.assertReady()).rejects.toMatchObject({
      message: "GitLab rejected the token from GITLAB_TOKEN for git.example.com.",
    });

    const forbidden = gitlab({ "GET /api/v4/user": { status: 403, body: { error: "insufficient_scope" } } });
    await expect(forbidden.provider.assertReady()).rejects.toMatchObject({ hint: expect.stringContaining("`api` scope") });
  });

  it("reports an unreachable API with an --api-url hint", async () => {
    const provider = new GitLabProvider(
      config(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(provider.assertReady()).rejects.toMatchObject({
      message: "Cannot reach the GitLab API at https://git.example.com: fetch failed",
      hint: expect.stringContaining("--api-url"),
    });
  });

  it("builds clone URLs and git auth for HTTPS URLs on its own host only", async () => {
    const t = gitlab({ "GET /api/v4/user": { status: 200, body: { username: "jane" } } });
    expect(t.provider.repoUrl("team/sub", "app", "https")).toBe("https://git.example.com/team/sub/app.git");
    expect(t.provider.repoUrl("team/sub", "app", "ssh")).toBe("git@git.example.com:team/sub/app.git");

    const auth = await t.provider.gitAuth("https://git.example.com/team/sub/app.git");
    expect(auth).toEqual({
      "http.https://git.example.com/.extraHeader": `Authorization: Basic ${Buffer.from("jane:tok-123").toString("base64")}`,
    });
    expect(await t.provider.gitAuth("git@git.example.com:team/app.git")).toBeUndefined();
    expect(await t.provider.gitAuth("https://elsewhere.com/team/app.git")).toBeUndefined();
  });
});

describe("GiteaProvider", () => {
  const user = { "GET /api/v1/user": { status: 200, body: { login: "Jane" } } };

  it("authenticates with `Authorization: token`", async () => {
    const t = gitea(user);
    expect(await t.provider.currentUser()).toBe("Jane");
    expect(t.requests[0]!.headers.Authorization).toBe("token tok-123");
  });

  it("checks existence via /repos/{owner}/{repo}", async () => {
    const t = gitea({ ...user, "GET /api/v1/repos/me/app": { status: 200, body: {} } });
    expect(await t.provider.repoExists("me", "app")).toBe(true);
    expect(await t.provider.repoExists("me", "missing")).toBe(false);
  });

  it("creates user repos under /user/repos (case-insensitive owner match)", async () => {
    const t = gitea({ ...user, "POST /api/v1/user/repos": { status: 201, body: {} } });
    await t.provider.createRepo("jane", "app", { visibility: "public", description: "d" });
    expect(t.requests.at(-1)).toMatchObject({ path: "/api/v1/user/repos", body: { name: "app", private: false, description: "d" } });
  });

  it("creates org repos under /orgs/{org}/repos and explains a missing org", async () => {
    const t = gitea({ ...user, "POST /api/v1/orgs/team/repos": { status: 201, body: {} } });
    await t.provider.createRepo("team", "app", { visibility: "private", description: "d" });
    expect(t.requests.at(-1)).toMatchObject({ path: "/api/v1/orgs/team/repos", body: { private: true } });

    await expect(t.provider.createRepo("ghost", "app", { visibility: "private", description: "d" })).rejects.toThrow(
      "Gitea organization ghost was not found on git.example.com.",
    );
  });

  it("rejects internal visibility before calling the API", async () => {
    const t = gitea(user);
    await expect(t.provider.createRepo("jane", "app", { visibility: "internal", description: "d" })).rejects.toThrow(
      "Gitea repositories cannot be internal.",
    );
    expect(t.calls()).toEqual([]);
  });
});

describe("provider registry", () => {
  it("detects well-known hosts and hosts named in the environment", () => {
    const env = { GITLAB_HOST: "https://gitlab.corp.com/", GITEA_HOST: "git.home.lan" };
    expect(detectProvider("github.com", env, "github.com")).toBe("github");
    expect(detectProvider("ghe.corp.com", env, "ghe.corp.com")).toBe("github");
    expect(detectProvider("gitlab.com", env, "github.com")).toBe("gitlab");
    expect(detectProvider("gitlab.corp.com", env, "github.com")).toBe("gitlab");
    expect(detectProvider("codeberg.org", env, "github.com")).toBe("gitea");
    expect(detectProvider("git.home.lan", env, "github.com")).toBe("gitea");
    expect(detectProvider("bitbucket.org", env, "github.com")).toBeUndefined();
  });

  it("prefers GIT_MIRROR_TOKEN, then the provider's own variable", () => {
    expect(findToken("gitlab", { GITLAB_TOKEN: "a", GIT_MIRROR_TOKEN: "b" })).toEqual({ token: "b", source: "GIT_MIRROR_TOKEN" });
    expect(findToken("gitlab", { GITLAB_TOKEN: " a " })).toEqual({ token: "a", source: "GITLAB_TOKEN" });
    expect(findToken("gitea", { FORGEJO_TOKEN: "c" })).toEqual({ token: "c", source: "FORGEJO_TOKEN" });
    expect(findToken("gitea", { GITLAB_TOKEN: "a" })).toBeUndefined();
  });

  it("has default hosts for GitHub and GitLab but not Gitea", () => {
    expect(defaultHost("github", {})).toBe("github.com");
    expect(defaultHost("gitlab", {})).toBe("gitlab.com");
    expect(defaultHost("gitlab", { GITLAB_HOST: "gitlab.corp.com" })).toBe("gitlab.corp.com");
    expect(defaultHost("gitea", {})).toBeUndefined();
  });

  it("refuses to build a token provider without a token", () => {
    const runner = async () => ({ code: 0, stdout: "", stderr: "" });
    expect(() => createProvider({ name: "gitea", host: "git.example.com", env: {}, runner })).toThrow(
      "No Gitea token found for git.example.com.",
    );
  });
});

describe("withGitConfig", () => {
  it("appends to existing GIT_CONFIG_* entries instead of replacing them", () => {
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.x.insteadOf", GIT_CONFIG_VALUE_0: "y", PATH: "/bin" };
    expect(withGitConfig(env, { "http.extraHeader": "A: b" })).toEqual({
      ...env,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "http.extraHeader",
      GIT_CONFIG_VALUE_1: "A: b",
    });
    expect(withGitConfig({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
