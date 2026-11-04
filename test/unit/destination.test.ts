import { describe, expect, it } from "vitest";
import { resolveDestination, type DestinationOptions } from "../../src/core/destination.js";
import { mirror, type MirrorOptions } from "../../src/core/mirror.js";
import { createFakeFetch, fakeGitLab, type Routes } from "../helpers/fake-api.js";
import { createFakeRunner, createMemoryLogger, fakeGh, fail, ok } from "../helpers/fake-runner.js";

const gitlabUser: Routes = { "GET /api/v4/user": { status: 200, body: { username: "jane" } } };
const giteaUser: Routes = { "GET /api/v1/user": { status: 200, body: { login: "jane" } } };

function resolve(options: Partial<DestinationOptions> & { destination: string }, routes: Routes = {}) {
  const api = createFakeFetch(routes);
  const fake = createFakeRunner({ gh: fakeGh({ user: "octocat" }) });
  const log = createMemoryLogger();
  const result = resolveDestination({ cwd: "/work", env: {}, ...options }, { runner: fake.runner, logger: log.logger, fetch: api.fetch });
  return { result, api, fake, log };
}

describe("resolveDestination", () => {
  it("auto-detects gitlab.com URLs when a token is set", async () => {
    const t = resolve({ destination: "https://gitlab.com/team/sub/app.git", env: { GITLAB_TOKEN: "t" } }, gitlabUser);
    const destination = await t.result;
    expect(destination).toMatchObject({
      kind: "hosted",
      namespace: "team/sub",
      repo: "app",
      url: "https://gitlab.com/team/sub/app.git",
      gitConfig: { "http.https://gitlab.com/.extraHeader": expect.stringMatching(/^Authorization: Basic /) },
    });
    expect(destination.kind === "hosted" && destination.provider.name).toBe("gitlab");
    expect(t.api.requests[0]!.url).toBe("https://gitlab.com/api/v4/user");
  });

  it("falls back to a plain remote for a detected GitLab URL without a token, and says how to enable creation", async () => {
    const t = resolve({ destination: "git@gitlab.com:team/app.git" });
    expect(await t.result).toEqual({ kind: "remote", url: "git@gitlab.com:team/app.git" });
    expect(t.log.text()).toContain("Set GITLAB_TOKEN to let git-mirror create it when missing.");
    expect(t.api.requests).toHaveLength(0);
  });

  it("treats unknown self-hosted URLs as plain remotes without touching gh or any API", async () => {
    const t = resolve({ destination: "https://git.corp.com/team/app.git", env: { GITLAB_TOKEN: "t" } });
    expect(await t.result).toEqual({ kind: "remote", url: "https://git.corp.com/team/app.git" });
    expect(t.fake.calls).toHaveLength(0);
    expect(t.api.requests).toHaveLength(0);
  });

  it("uses --provider for self-hosted URLs, keeping the URL's port for the API", async () => {
    const t = resolve(
      { destination: "http://gitea.local:3000/me/app.git", provider: "gitea", env: { GITEA_TOKEN: "t" } },
      giteaUser,
    );
    const destination = await t.result;
    expect(destination).toMatchObject({ kind: "hosted", namespace: "me", repo: "app" });
    expect(t.api.requests[0]!.url).toBe("http://gitea.local:3000/api/v1/user");
    expect(destination.kind === "hosted" && destination.gitConfig).toHaveProperty(["http.http://gitea.local:3000/.extraHeader"]);
  });

  it("calls the API over https://<host> for SSH URLs (and sends no git auth: SSH keys handle it)", async () => {
    const t = resolve({ destination: "ssh://git@gitlab.corp.com:2222/team/app.git", provider: "gitlab", env: { GITLAB_TOKEN: "t" } }, gitlabUser);
    const destination = await t.result;
    expect(t.api.requests[0]!.url).toBe("https://gitlab.corp.com/api/v4/user");
    expect(destination).toMatchObject({ kind: "hosted", url: "ssh://git@gitlab.corp.com:2222/team/app.git", gitConfig: undefined });
  });

  it("honours --api-url", async () => {
    const t = resolve(
      { destination: "git@gitea.corp.com:me/app.git", provider: "gitea", apiUrl: "https://gitea-api.corp.com/", env: { GITEA_TOKEN: "t" } },
      giteaUser,
    );
    await t.result;
    expect(t.api.requests[0]!.url).toBe("https://gitea-api.corp.com/api/v1/user");
  });

  it("resolves GitLab shorthand against gitlab.com, GITLAB_HOST, or --host, with the token user as default namespace", async () => {
    const def = await resolve({ destination: "app", provider: "gitlab", env: { GITLAB_TOKEN: "t" } }, gitlabUser).result;
    expect(def).toMatchObject({ namespace: "jane", repo: "app", url: "https://gitlab.com/jane/app.git", protocol: "https" });

    const fromEnv = await resolve(
      { destination: "team/sub/app", provider: "gitlab", env: { GITLAB_TOKEN: "t", GITLAB_HOST: "gitlab.corp.com" } },
      gitlabUser,
    ).result;
    expect(fromEnv).toMatchObject({ namespace: "team/sub", url: "https://gitlab.corp.com/team/sub/app.git" });

    const ssh = await resolve(
      { destination: "team/app", provider: "gitlab", host: "git.example.com", protocol: "ssh", env: { GITLAB_TOKEN: "t" } },
      gitlabUser,
    ).result;
    expect(ssh).toMatchObject({ url: "git@git.example.com:team/app.git", gitConfig: undefined });
  });

  it("requires a host for Gitea shorthand", async () => {
    await expect(resolve({ destination: "me/app", provider: "gitea", env: { GITEA_TOKEN: "t" } }).result).rejects.toMatchObject({
      message: "--host is required for Gitea shorthand destinations.",
    });
  });

  it("requires a token when --provider is explicit", async () => {
    await expect(resolve({ destination: "team/app", provider: "gitlab" }).result).rejects.toMatchObject({
      message: "No GitLab token found for gitlab.com.",
      hint: expect.stringContaining("GITLAB_TOKEN"),
    });
  });

  it("rejects nested namespaces outside GitLab", async () => {
    await expect(resolve({ destination: "a/b/c" }).result).rejects.toMatchObject({ hint: expect.stringContaining("--provider gitlab") });
    await expect(
      resolve({ destination: "https://codeberg.org/a/b/c.git", provider: "gitea", env: { GITEA_TOKEN: "t" } }).result,
    ).rejects.toThrow("is not a Gitea repository URL");
  });

  it("keeps --host as the GitHub Enterprise host when no provider is given", async () => {
    const t = resolve({ destination: "org/app", host: "ghe.corp.com" });
    expect(await t.result).toMatchObject({ kind: "hosted", url: "https://ghe.corp.com/org/app.git" });
  });
});

describe("mirror to GitLab", () => {
  const base: MirrorOptions = {
    source: "https://github.com/someone/app.git",
    destination: "team/sub/app",
    provider: "gitlab",
    host: "gitlab.corp.com",
    visibility: "private",
    create: true,
    force: false,
    dryRun: false,
    keepHostRefs: false,
    quiet: true,
    cwd: "/work",
    env: { GITLAB_TOKEN: "glpat-secret" },
  };

  function setup(options: Partial<MirrorOptions> = {}) {
    const api = fakeGitLab({ user: "jane", groups: { "team/sub": 42 } });
    const fake = createFakeRunner({
      git: (args) => (args[0] === "ls-remote" && args[1] === base.source ? ok("abc\trefs/heads/main") : ok()),
    });
    const log = createMemoryLogger();
    const run = () =>
      mirror({ ...base, ...options }, { runner: fake.runner, logger: log.logger, fetch: api.fetch, makeTempDir: async () => "/tmp/x", removeDir: async () => {} });
    return { api, fake, log, run };
  }

  it("creates the project in the subgroup and pushes with the token as an HTTP header, never gh", async () => {
    const t = setup();
    const result = await t.run();

    expect(result).toMatchObject({ provider: "gitlab", slug: "team/sub/app", created: true, destinationUrl: "https://gitlab.corp.com/team/sub/app.git" });
    expect(t.api.projects.has("team/sub/app")).toBe(true);
    expect(t.fake.calls.some((call) => call.command === "gh")).toBe(false);

    const push = t.fake.calls.find((call) => call.args[0] === "push")!;
    expect(push.args).toEqual(["push", "--mirror", "--quiet", "https://gitlab.corp.com/team/sub/app.git"]);
    expect(push.options?.gitConfig).toEqual({
      "http.https://gitlab.corp.com/.extraHeader": `Authorization: Basic ${Buffer.from("jane:glpat-secret").toString("base64")}`,
    });
    // The token is only ever in git config passed through the environment, never in arguments or logs.
    expect(JSON.stringify(t.fake.calls.map((call) => call.args))).not.toContain("glpat-secret");
    expect(t.log.text()).toContain("Created private repository team/sub/app on gitlab.corp.com.");
  });

  it("dry run checks the API but creates and pushes nothing", async () => {
    const t = setup({ dryRun: true });
    await t.run();
    expect(t.api.calls().some((call) => call.startsWith("POST"))).toBe(false);
    expect(t.fake.commands("git").some((c) => c.startsWith("push") || c.startsWith("clone"))).toBe(false);
    expect(t.log.text()).toContain("Would create private repository team/sub/app on gitlab.corp.com.");
  });

  it("hints at --provider when a plain remote cannot be read", async () => {
    // First ls-remote is the source check; the second reads the (missing) destination.
    let lsRemoteCalls = 0;
    const fake = createFakeRunner({
      git: (args) =>
        args[0] !== "ls-remote"
          ? ok()
          : lsRemoteCalls++ === 0
            ? ok("abc\trefs/heads/main")
            : fail("remote: Repository not found.\nfatal: repository 'https://git.corp.com/team/app.git/' not found", 128),
    });
    const options = { ...base, destination: "https://git.corp.com/team/app.git", provider: undefined, host: undefined };
    const error = await mirror(options, { runner: fake.runner, logger: createMemoryLogger().logger }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: "Cannot read destination https://git.corp.com/team/app.git: fatal: repository 'https://git.corp.com/team/app.git/' not found",
      hint: expect.stringContaining("--provider gitlab|gitea"),
    });
  });
});
