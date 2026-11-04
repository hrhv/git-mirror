import { describe, expect, it, vi } from "vitest";
import { MirrorError } from "../../src/core/errors.js";
import type { RunResult } from "../../src/core/exec.js";
import { mirror, type MirrorDeps, type MirrorOptions } from "../../src/core/mirror.js";
import { createFakeRunner, createMemoryLogger, fail, fakeGh, ok, type FakeGhState, type Handler } from "../helpers/fake-runner.js";

interface FakeGitState {
  /** Result of `git ls-remote <source>` (default: one branch). */
  source?: Partial<RunResult>;
  /** Refs printed by `git ls-remote <destination>`. */
  destinationRefs?: string;
  pullRefs?: string[];
  pushFails?: boolean;
}

function fakeGit(state: FakeGitState = {}): Handler {
  let lsRemoteCalls = 0;
  return (args) => {
    const sub = args[0] === "-C" ? args[2] : args[0];
    switch (sub) {
      case "--version":
        return ok("git version 2.50.0");
      case "rev-parse":
        return ok("/work/my-project");
      case "ls-remote":
        // mirror() always checks the source before it looks at the destination.
        return lsRemoteCalls++ === 0 ? (state.source ?? ok("abc\trefs/heads/main")) : ok(state.destinationRefs ?? "");
      case "clone":
        return ok();
      case "for-each-ref":
        return ok((state.pullRefs ?? []).join("\n"));
      case "update-ref":
        return ok();
      case "push":
        return state.pushFails ? fail("remote: Permission denied") : ok();
      default:
        return fail(`fake git: unsupported ${args.join(" ")}`);
    }
  };
}

function setup({ gh, git, options, deps }: { gh?: FakeGhState; git?: FakeGitState; options?: Partial<MirrorOptions>; deps?: Partial<MirrorDeps> } = {}) {
  const fake = createFakeRunner({ gh: fakeGh(gh), git: fakeGit(git) });
  const log = createMemoryLogger();
  const removeDir = vi.fn(async () => {});
  const fullOptions: MirrorOptions = {
    source: "https://gitlab.com/team/app.git",
    destination: "app-backup",
    host: "github.com",
    visibility: "private",
    create: true,
    force: false,
    dryRun: false,
    keepHostRefs: false,
    quiet: true,
    cwd: "/work",
    env: {},
    ...options,
  };
  const fullDeps: MirrorDeps = {
    runner: fake.runner,
    logger: log.logger,
    makeTempDir: async () => "/tmp/git-mirror-x",
    removeDir,
    isDirectory: (path) => path === "/work/my-project",
    ...deps,
  };
  return { ...fake, log, removeDir, run: () => mirror(fullOptions, fullDeps) };
}

describe("mirror (GitHub destination)", () => {
  it("creates a missing private repo under the authenticated user and pushes everything", async () => {
    const t = setup({ gh: { user: "jane", protocol: "ssh" } });

    const result = await t.run();

    expect(result).toEqual({
      sourceUrl: "https://gitlab.com/team/app.git",
      destinationUrl: "git@github.com:jane/app-backup.git",
      slug: "jane/app-backup",
      provider: "github",
      created: true,
      dryRun: false,
    });
    expect(t.commands("gh")).toContain("repo create jane/app-backup --private --description Mirror of app");
    expect(t.commands("git")).toEqual([
      "--version",
      "ls-remote https://gitlab.com/team/app.git",
      "clone --mirror --quiet https://gitlab.com/team/app.git /tmp/git-mirror-x/repo.git",
      "for-each-ref --format=%(refname) refs/pull/ refs/merge-requests/ refs/pipelines/ refs/keep-around/ refs/environments/",
      "push --mirror --quiet git@github.com:jane/app-backup.git",
    ]);
    expect(t.removeDir).toHaveBeenCalledWith("/tmp/git-mirror-x");
  });

  it("passes GH_HOST so GitHub Enterprise hosts work", async () => {
    const t = setup({ options: { host: "ghe.corp.com", destination: "org/app" } });
    await t.run();
    const ghCalls = t.calls.filter((call) => call.command === "gh");
    expect(ghCalls.every((call) => call.options?.env?.GH_HOST === "ghe.corp.com")).toBe(true);
    expect(t.commands("git")).toContain("push --mirror --quiet https://ghe.corp.com/org/app.git");
  });

  it("uses the requested visibility, description and protocol", async () => {
    const t = setup({ options: { visibility: "public", description: "Backup", protocol: "https", destination: "org/app" } });
    const result = await t.run();
    expect(t.commands("gh")).toContain("repo create org/app --public --description Backup");
    expect(t.commands("gh").some((c) => c.startsWith("config get"))).toBe(false);
    expect(result.destinationUrl).toBe("https://github.com/org/app.git");
  });

  it("fails with a hint when gh is not logged in, before touching anything", async () => {
    const t = setup({ gh: { authenticated: false } });
    await expect(t.run()).rejects.toThrow(/not logged in to github\.com/);
    expect(t.commands("gh")).toEqual(["auth status --hostname github.com"]);
  });

  it("refuses to create the repo when --no-create is given", async () => {
    const t = setup({ options: { create: false } });
    await expect(t.run()).rejects.toThrow("octocat/app-backup on github.com does not exist.");
    expect(t.commands("gh").some((c) => c.startsWith("repo create"))).toBe(false);
  });

  it("pushes into an existing empty repo without asking", async () => {
    const t = setup({ gh: { repos: new Set(["octocat/app-backup"]) } });
    const result = await t.run();
    expect(result.created).toBe(false);
    expect(t.commands("git")).toContain("push --mirror --quiet https://github.com/octocat/app-backup.git");
  });

  it("strips refs/pull/* before pushing, unless asked to keep them", async () => {
    const pullRefs = ["refs/pull/1/head", "refs/pull/2/merge"];
    const t = setup({ git: { pullRefs } });
    await t.run();
    const updateRef = t.calls.find((call) => call.args[0] === "update-ref");
    expect(updateRef?.options?.input).toBe("delete refs/pull/1/head\ndelete refs/pull/2/merge\n");

    const kept = setup({ git: { pullRefs }, options: { keepHostRefs: true } });
    await kept.run();
    expect(kept.commands("git").some((c) => c.startsWith("for-each-ref") || c.startsWith("update-ref"))).toBe(false);
  });
});

describe("mirror (overwrite protection)", () => {
  const existing = { gh: { repos: new Set(["octocat/app-backup"]) }, git: { destinationRefs: "abc\trefs/heads/main" } };

  it("refuses to overwrite a non-empty destination when not interactive", async () => {
    const t = setup(existing);
    await expect(t.run()).rejects.toMatchObject({ message: expect.stringContaining("already has content"), hint: expect.stringContaining("--force") });
    expect(t.commands("git").some((c) => c.startsWith("push"))).toBe(false);
  });

  it("asks for confirmation when interactive and aborts on no", async () => {
    const confirm = vi.fn(async () => false);
    const t = setup({ ...existing, deps: { confirm } });
    await expect(t.run()).rejects.toThrow("Aborted.");
    expect(confirm).toHaveBeenCalledOnce();
    expect(t.commands("git").some((c) => c.startsWith("clone"))).toBe(false);
  });

  it("proceeds when the user confirms", async () => {
    const t = setup({ ...existing, deps: { confirm: async () => true } });
    await t.run();
    expect(t.commands("git")).toContain("push --mirror --quiet https://github.com/octocat/app-backup.git");
  });

  it("proceeds without asking when --force is given", async () => {
    const confirm = vi.fn(async () => false);
    const t = setup({ ...existing, options: { force: true }, deps: { confirm } });
    await t.run();
    expect(confirm).not.toHaveBeenCalled();
    expect(t.commands("git")).toContain("push --mirror --quiet https://github.com/octocat/app-backup.git");
  });
});

describe("mirror (dry run)", () => {
  it("creates nothing and pushes nothing", async () => {
    const t = setup({ options: { dryRun: true } });
    const result = await t.run();
    expect(result).toMatchObject({ dryRun: true, created: true });
    expect(t.commands("gh").some((c) => c.startsWith("repo create"))).toBe(false);
    expect(t.commands("git")).toEqual(["--version", "ls-remote https://gitlab.com/team/app.git"]);
    expect(t.log.text()).toContain("Would create private repository octocat/app-backup on github.com.");
  });

  it("warns instead of failing when the destination already has content", async () => {
    const t = setup({ gh: { repos: new Set(["octocat/app-backup"]) }, git: { destinationRefs: "abc\trefs/heads/main" }, options: { dryRun: true } });
    await t.run();
    expect(t.log.text()).toMatch(/warn: .*already has content/);
  });
});

describe("mirror (sources)", () => {
  it("expands owner/repo shorthand to a GitHub URL using the same protocol", async () => {
    const t = setup({ gh: { protocol: "ssh" }, options: { source: "vercel/next.js" } });
    const result = await t.run();
    expect(result.sourceUrl).toBe("git@github.com:vercel/next.js.git");
    expect(t.commands("gh")).toContain("repo create octocat/app-backup --private --description Mirror of next.js");
  });

  it("resolves a local directory to an absolute path and names it after the repo", async () => {
    const t = setup({ options: { source: "./my-project" } });
    const result = await t.run();
    expect(result.sourceUrl).toBe("/work/my-project");
    expect(t.commands("gh")).toContain("repo create octocat/app-backup --private --description Mirror of my-project");
  });

  it("rejects a path that does not exist", async () => {
    const t = setup({ options: { source: "./missing" } });
    await expect(t.run()).rejects.toThrow("Source path /work/missing does not exist.");
  });

  it("rejects mirroring a repo onto itself", async () => {
    const t = setup({ options: { source: "octocat/app-backup", protocol: "https" } });
    await expect(t.run()).rejects.toThrow("Source and destination are the same repository.");
  });
});

describe("mirror (URL sources)", () => {
  it.each([
    ["https://gitlab.com/team/app.git", "app"],
    ["git@gitlab.com:team/sub/app.git", "app"],
    ["ssh://git@git.example.com:2222/team/app.git", "app"],
    ["myserver:repos/app.git", "app"],
    ["https://github.com/someone/project", "project"],
  ])("clones %s as-is", async (source, name) => {
    const t = setup({ options: { source } });
    const result = await t.run();
    expect(result.sourceUrl).toBe(source);
    expect(t.commands("git")).toContain(`ls-remote ${source}`);
    expect(t.commands("git")).toContain(`clone --mirror --quiet ${source} /tmp/git-mirror-x/repo.git`);
    expect(t.commands("gh")).toContain(`repo create octocat/app-backup --private --description Mirror of ${name}`);
  });

  it("fails before creating anything when the source cannot be read", async () => {
    const t = setup({
      options: { source: "https://gitlab.com/team/private.git" },
      git: { source: fail("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/team/private.git/'", 128) },
    });
    await expect(t.run()).rejects.toMatchObject({
      message: "Cannot read source https://gitlab.com/team/private.git: fatal: Authentication failed for 'https://gitlab.com/team/private.git/'",
      hint: expect.stringContaining("gh auth setup-git"),
    });
    expect(t.commands("gh").some((c) => c.startsWith("repo create"))).toBe(false);
    expect(t.commands("git").some((c) => c.startsWith("clone"))).toBe(false);
  });

  it("gives an SSH-specific hint for SSH sources", async () => {
    const t = setup({
      options: { source: "git@gitlab.com:team/app.git" },
      git: { source: fail("git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", 128) },
    });
    await expect(t.run()).rejects.toMatchObject({ hint: expect.stringContaining("SSH key") });
  });

  it("refuses an empty source repository", async () => {
    const t = setup({ git: { source: ok("") } });
    await expect(t.run()).rejects.toThrow("Source https://gitlab.com/team/app.git has no branches or tags to mirror.");
    expect(t.commands("gh").some((c) => c.startsWith("repo create"))).toBe(false);
  });

  it("never prints credentials embedded in the URL", async () => {
    const source = "https://deploy:hunter2@gitlab.com/team/app.git";
    const ok1 = setup({ options: { source, quiet: false } });
    await ok1.run();
    expect(ok1.log.text()).toContain("https://deploy:***@gitlab.com/team/app.git");
    expect(ok1.log.text()).not.toContain("hunter2");

    // git quotes the URL, credentials included, in its own error output.
    const gitError = "fatal: could not read Password for 'https://deploy:hunter2@gitlab.com': terminal prompts disabled";
    const failing = setup({ options: { source }, git: { source: fail(gitError, 128) } });
    const error = (await failing.run().catch((e: unknown) => e)) as MirrorError;
    expect(error.message).toContain("'https://deploy:***@gitlab.com'");
    expect(`${error.message} ${error.hint}`).not.toContain("hunter2");
  });

  it("treats the SSH and HTTPS URLs of the same GitHub repo as the same repository", async () => {
    const t = setup({ options: { source: "git@github.com:octocat/app-backup.git", protocol: "https" } });
    await expect(t.run()).rejects.toThrow("Source and destination are the same repository.");
  });
});

describe("mirror (failures)", () => {
  it("cleans up the temp directory when the push fails", async () => {
    const t = setup({ git: { pushFails: true } });
    const error = await t.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MirrorError);
    expect(error).toMatchObject({ hint: "remote: Permission denied" });
    expect(t.removeDir).toHaveBeenCalledWith("/tmp/git-mirror-x");
  });
});
