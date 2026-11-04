import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirror, type MirrorOptions } from "../../src/core/mirror.js";
import { withGitConfig } from "../../src/core/exec.js";
import { fakeGitLab } from "../helpers/fake-api.js";
import { createFakeRunner, createMemoryLogger, fakeGh } from "../helpers/fake-runner.js";
import { createBareRepo, createSourceRepo, git, gitRunner, listRefs, makeTempDir, removeDir } from "../helpers/git-fixtures.js";

/** These tests run the real git binary against repositories in a temp directory. */
describe("mirror with real git", () => {
  let root: string;
  let source: string;
  let log: ReturnType<typeof createMemoryLogger>;

  beforeEach(async () => {
    root = await makeTempDir();
    source = join(root, "source");
    await mkdir(source);
    await createSourceRepo(source);
    log = createMemoryLogger();
  });

  afterEach(async () => {
    await removeDir(root);
  });

  const options = (overrides: Partial<MirrorOptions>): MirrorOptions => ({
    source,
    destination: "",
    host: "github.com",
    visibility: "private",
    create: true,
    force: false,
    dryRun: false,
    keepHostRefs: false,
    quiet: true,
    cwd: root,
    env: {},
    ...overrides,
  });

  it("copies every branch and tag (lightweight and annotated) to a bare remote", async () => {
    const destination = await createBareRepo(join(root, "dest.git"));

    await mirror(options({ destination }), { runner: gitRunner(), logger: log.logger });

    const refs = await listRefs(destination);
    expect(refs).toEqual(await listRefs(source));
    expect(refs.map((ref) => ref.split(" ")[0])).toEqual([
      "refs/heads/feature/login",
      "refs/heads/main",
      "refs/tags/v1.0.0",
      "refs/tags/v1.1.0",
    ]);
    expect(await git(destination, "cat-file", "-t", "v1.1.0")).toBe("tag");
  });

  it("accepts a relative source path", async () => {
    const destination = await createBareRepo(join(root, "dest.git"));
    await mirror(options({ source: "./source", destination: "./dest.git" }), { runner: gitRunner(), logger: log.logger });
    expect(await listRefs(destination)).toEqual(await listRefs(source));
  });

  it("mirrors from a git URL (file:// transport, same code path as https/ssh)", async () => {
    const destination = await createBareRepo(join(root, "dest.git"));
    const result = await mirror(options({ source: `file://${source}`, destination }), { runner: gitRunner(), logger: log.logger });
    expect(result.sourceUrl).toBe(`file://${source}`);
    expect(await listRefs(destination)).toEqual(await listRefs(source));
  });

  it("fails on an unreachable URL without touching the destination", async () => {
    const destination = await createBareRepo(join(root, "dest.git"));
    await expect(
      mirror(options({ source: `file://${join(root, "nope.git")}`, destination }), { runner: gitRunner(), logger: log.logger }),
    ).rejects.toThrow(/^Cannot read source file:\/\/.*nope\.git/);
    expect(await listRefs(destination)).toEqual([]);
  });

  it("drops host-generated refs (pull and merge requests) by default and keeps them with keepHostRefs", async () => {
    const head = await git(source, "rev-parse", "main");
    await git(source, "update-ref", "refs/pull/7/head", head);
    await git(source, "update-ref", "refs/merge-requests/3/head", head);

    const stripped = await createBareRepo(join(root, "stripped.git"));
    await mirror(options({ destination: stripped }), { runner: gitRunner(), logger: log.logger });
    expect((await listRefs(stripped)).some((ref) => /^refs\/(pull|merge-requests)\//.test(ref))).toBe(false);
    expect(log.text()).toContain("Skipping 2 pull/merge request ref(s)");

    const kept = await createBareRepo(join(root, "kept.git"));
    await mirror(options({ destination: kept, keepHostRefs: true }), { runner: gitRunner(), logger: log.logger });
    expect(await listRefs(kept)).toContain(`refs/pull/7/head ${head}`);
    expect(await listRefs(kept)).toContain(`refs/merge-requests/3/head ${head}`);
  });

  it("refuses to overwrite a non-empty remote, then replaces it exactly with --force", async () => {
    const destination = await createBareRepo(join(root, "dest.git"));
    await git(source, "push", destination, "main:refs/heads/stale-branch");

    await expect(mirror(options({ destination }), { runner: gitRunner(), logger: log.logger })).rejects.toThrow(/already has content/);
    expect(await listRefs(destination)).toHaveLength(1);

    await mirror(options({ destination, force: true }), { runner: gitRunner(), logger: log.logger });
    const refs = await listRefs(destination);
    expect(refs).toEqual(await listRefs(source));
    expect(refs.some((ref) => ref.startsWith("refs/heads/stale-branch"))).toBe(false);
  });

  it("re-running after new commits updates the mirror (with --force)", async () => {
    const destination = await createBareRepo(join(root, "dest.git"));
    await mirror(options({ destination }), { runner: gitRunner(), logger: log.logger });

    await git(source, "commit", "--allow-empty", "-m", "second", "--quiet");
    await mirror(options({ destination, force: true }), { runner: gitRunner(), logger: log.logger });

    expect(await git(destination, "rev-parse", "main")).toBe(await git(source, "rev-parse", "main"));
  });

  it("fails clearly when the source directory is not a git repository", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "file.txt"), "hello");
    const destination = await createBareRepo(join(root, "dest.git"));

    await expect(mirror(options({ source: plain, destination }), { runner: gitRunner(), logger: log.logger })).rejects.toThrow(
      `${plain} is not a git repository.`,
    );
  });

  it("runs the full GitHub flow: resolves the owner, creates the repo, and pushes", async () => {
    // Real git, fake gh: GitHub URLs are rewritten to local bare repos that "gh repo create" initialises.
    const fakeGithub = join(root, "github");
    const runner = gitRunner({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${fakeGithub}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
    });
    const { runner: withGh, commands } = createFakeRunner(
      {
        gh: fakeGh({
          user: "jane",
          onCreate: async (slug) => {
            const dir = join(fakeGithub, `${slug}.git`);
            await mkdir(dir, { recursive: true });
            await createBareRepo(dir);
          },
        }),
      },
      runner,
    );

    const result = await mirror(options({ destination: "backup" }), { runner: withGh, logger: log.logger });

    expect(result).toMatchObject({ slug: "jane/backup", destinationUrl: "https://github.com/jane/backup.git", created: true });
    expect(commands("gh")).toContain("repo create jane/backup --private --description Mirror of source");
    expect(await listRefs(join(fakeGithub, "jane/backup.git"))).toEqual(await listRefs(source));
  });

  it("runs the full GitLab flow: creates the project through the API and pushes with token auth", async () => {
    // Real git; GitLab's API is faked and its URLs are rewritten to local bare repos.
    const fakeGitLabDir = join(root, "gitlab");
    const urlRewrite = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${fakeGitLabDir}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://gitlab.corp.com/",
    };
    const api = fakeGitLab({ user: "jane", groups: { "team/sub": 7 } });
    const baseRunner = gitRunner(urlRewrite);
    // Create the bare repo when the API creates the project (the fake API only records it).
    const runner: typeof baseRunner = async (command, args, opts) => {
      for (const project of api.projects) await createBareRepo(join(fakeGitLabDir, `${project}.git`));
      return baseRunner(command, args, opts);
    };

    const result = await mirror(
      options({ destination: "team/sub/app", provider: "gitlab", host: "gitlab.corp.com", env: { GITLAB_TOKEN: "glpat-x" } }),
      { runner, logger: log.logger, fetch: api.fetch },
    );

    expect(result).toMatchObject({ provider: "gitlab", slug: "team/sub/app", created: true });
    expect(await listRefs(join(fakeGitLabDir, "team/sub/app.git"))).toEqual(await listRefs(source));
  });

  it("real git applies the token header to the destination host only, alongside existing GIT_CONFIG entries", async () => {
    const env = withGitConfig(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.x.insteadOf", GIT_CONFIG_VALUE_0: "y" },
      { "http.https://gitlab.corp.com/.extraHeader": "Authorization: Basic abc" },
    ) as Record<string, string>;
    const urlmatch = (url: string) => gitRunner(env)("git", ["config", "--get-urlmatch", "http.extraHeader", url], { cwd: root });

    expect((await urlmatch("https://gitlab.corp.com/team/app.git")).stdout.trim()).toBe("Authorization: Basic abc");
    expect((await urlmatch("https://github.com/team/app.git")).code).not.toBe(0);
    expect((await gitRunner(env)("git", ["config", "url.x.insteadOf"], { cwd: root })).stdout.trim()).toBe("y");
  });
});
