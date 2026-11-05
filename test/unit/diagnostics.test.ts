import { describe, expect, it } from "vitest";
import { collectDiagnostics, findOnPath, formatDiagnostics, type HostInfo } from "../../src/core/diagnostics.js";
import { MirrorError } from "../../src/core/errors.js";
import { spawnRunner } from "../../src/core/exec.js";
import { createFakeRunner, fail, ok, type Handler } from "../helpers/fake-runner.js";

function host(overrides: Partial<HostInfo> = {}, executables: string[] = []): HostInfo {
  return {
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.4.0",
    execPath: "/Users/jane/.local/bin/git-mirror",
    runtime: { name: "bun", version: "1.3.14" },
    homedir: "/Users/jane",
    tmpdir: "/var/folders/xy/T",
    stdoutIsTTY: true,
    readFile: () => undefined,
    exists: () => false,
    isExecutable: (path) => executables.includes(path),
    ...overrides,
  };
}

const missing: Handler = () => {
  throw new MirrorError("`tool` was not found on your PATH.");
};

const macHandlers: Record<string, Handler> = {
  sw_vers: (args) => ok(args[0] === "-productVersion" ? "26.4\n" : "25E246\n"),
  sysctl: () => ok("0\n"),
  git: (args) => (args[0] === "--version" ? ok("git version 2.50.1\n") : ok("osxkeychain\n")),
  gh: (args) => {
    if (args[0] === "--version") return ok("gh version 2.79.0 (2025-09-08)\nhttps://github.com/cli/cli/releases/tag/v2.79.0\n");
    if (args[0] === "auth") return ok("github.com\n  ✓ Logged in to github.com account jane (keyring)\n");
    return ok("ssh\n");
  },
  ssh: () => ({ code: 0, stdout: "", stderr: "OpenSSH_10.2p1, LibreSSL 3.3.6\n" }),
};

async function report(options: { handlers?: Record<string, Handler>; env?: Record<string, string>; host?: HostInfo } = {}) {
  const fake = createFakeRunner(options.handlers ?? macHandlers);
  const diagnostics = await collectDiagnostics({
    version: "1.2.3",
    runner: fake.runner,
    env: { PATH: "/Users/jane/.local/bin:/usr/bin:/opt/homebrew/bin", SHELL: "/bin/zsh", ...options.env },
    host: options.host ?? host({}, ["/Users/jane/.local/bin/git-mirror", "/usr/bin/git", "/opt/homebrew/bin/gh"]),
  });
  const text = formatDiagnostics(diagnostics);
  const row = (label: string) => diagnostics.sections.flatMap((s) => s.rows).find((r) => r.label.trim() === label);
  return { diagnostics, text, row, fake };
}

describe("collectDiagnostics", () => {
  it("reports version, install type, OS and dependencies on a healthy Mac", async () => {
    const { diagnostics, text, row } = await report();

    expect(diagnostics.title).toBe("git-mirror 1.2.3");
    expect(row("install")?.value).toBe("standalone binary");
    expect(row("runtime")?.value).toBe("Bun 1.3.14");
    expect(row("executable")?.value).toBe("~/.local/bin/git-mirror");
    expect(row("os")?.value).toBe("macOS 26.4 (25E246), Darwin 25.4.0");
    expect(row("arch")?.value).toBe("arm64");
    expect(row("git")).toMatchObject({ value: "2.50.1  /usr/bin/git", status: "ok" });
    expect(row("credential helper")?.value).toBe("osxkeychain");
    expect(row("gh")).toMatchObject({ value: "2.79.0 (2025-09-08)  /opt/homebrew/bin/gh", status: "ok" });
    expect(row("auth")).toMatchObject({ value: "logged in to github.com as jane", status: "ok" });
    expect(row("git_protocol")?.value).toBe("ssh");
    expect(row("ssh")?.value).toBe("OpenSSH_10.2p1, LibreSSL 3.3.6");
    expect(diagnostics.problems).toEqual([]);
    expect(text).toContain("No problems found.");
  });

  it("describes an npm install by its script path", async () => {
    const { row } = await report({
      host: host({ runtime: { name: "node", version: "22.12.0" }, execPath: "/usr/bin/node", scriptPath: "/usr/lib/node_modules/@hrhv/git-mirror/dist/index.js" }),
    });
    expect(row("install")?.value).toBe("npm package");
    expect(row("runtime")?.value).toBe("Node.js 22.12.0");
    expect(row("executable")?.value).toBe("/usr/lib/node_modules/@hrhv/git-mirror/dist/index.js");
  });

  it("reports the distro and libc on Linux", async () => {
    const alpine = host({
      platform: "linux",
      arch: "x64",
      osRelease: "6.8.0",
      homedir: "/home/jane",
      readFile: (path) => (path === "/etc/os-release" ? 'NAME="Alpine Linux"\nPRETTY_NAME="Alpine Linux v3.22"\n' : undefined),
      exists: (path) => path === "/lib/ld-musl-x86_64.so.1",
    });
    const musl = await report({ host: alpine, handlers: { ...macHandlers, getconf: missing } });
    expect(musl.row("os")?.value).toBe("Alpine Linux v3.22, kernel 6.8.0");
    expect(musl.row("libc")?.value).toBe("musl");

    const debian = await report({
      host: { ...alpine, readFile: () => 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n', exists: () => false },
      handlers: { ...macHandlers, getconf: () => ok("glibc 2.41\n") },
    });
    expect(debian.row("libc")?.value).toBe("glibc 2.41");
  });

  it("flags a missing git as an error and a missing gh as a warning", async () => {
    const { diagnostics, row } = await report({ handlers: { ...macHandlers, git: missing, gh: missing } });
    expect(row("git")).toMatchObject({ status: "error", value: expect.stringContaining("not found") });
    expect(row("gh")).toMatchObject({ status: "warn", value: expect.stringContaining("only for GitHub") });
    expect(diagnostics.problems).toEqual(["git is not installed or not on PATH; git-mirror cannot work without it."]);
  });

  it("flags gh not logged in to the configured host", async () => {
    const { diagnostics, row, fake } = await report({
      env: { GH_HOST: "ghe.corp.com" },
      handlers: { ...macHandlers, gh: (args) => (args[0] === "auth" ? fail("You are not logged into any GitHub hosts.") : ok("gh version 2.79.0\n")) },
    });
    expect(fake.commands("gh")).toContain("auth status --hostname ghe.corp.com");
    expect(row("auth")).toMatchObject({ status: "warn", value: "not logged in to ghe.corp.com (run: gh auth login --hostname ghe.corp.com)" });
    expect(diagnostics.problems[0]).toContain("gh is not logged in to ghe.corp.com");
  });

  it("reports a gh check that timed out instead of hanging", async () => {
    const { row } = await report({
      handlers: { ...macHandlers, gh: (args) => (args[0] === "auth" ? { code: 124, timedOut: true } : ok("gh version 2.79.0\n")) },
    });
    expect(row("auth")).toMatchObject({ status: "warn", value: "could not check github.com (timed out)" });
  });

  it("warns when several git-mirror installs are on PATH", async () => {
    const { diagnostics, row } = await report({
      env: { PATH: "/Users/jane/.local/bin:/opt/homebrew/bin" },
      host: host({}, ["/Users/jane/.local/bin/git-mirror", "/opt/homebrew/bin/git-mirror"]),
    });
    expect(row("on PATH")).toMatchObject({ status: "warn", value: "~/.local/bin/git-mirror, /opt/homebrew/bin/git-mirror" });
    expect(diagnostics.problems[0]).toContain("Several git-mirror installs are on PATH");
  });

  it("notices Rosetta", async () => {
    const { diagnostics, row } = await report({ host: host({ arch: "x64" }), handlers: { ...macHandlers, sysctl: () => ok("1\n") } });
    expect(row("arch")?.value).toBe("x64 (running under Rosetta on Apple Silicon)");
    expect(diagnostics.problems[0]).toContain("Rosetta");
  });

  it("never prints token values and masks proxy credentials", async () => {
    const { text, row } = await report({
      env: {
        GITLAB_TOKEN: "glpat-SECRET-1",
        GH_TOKEN: "ghp_SECRET2",
        GITLAB_HOST: "gitlab.corp.com",
        HTTPS_PROXY: "http://user:hunter2@proxy.corp:3128",
        GIT_SSH_COMMAND: "ssh -i ~/.ssh/secret_key",
      },
    });
    expect(row("GITLAB_TOKEN")?.value).toBe("set");
    expect(row("GH_TOKEN")?.value).toBe("set");
    expect(row("GITEA_TOKEN")?.value).toBe("not set");
    expect(row("GITLAB_HOST")?.value).toBe("gitlab.corp.com");
    expect(row("HTTPS_PROXY")?.value).toBe("http://user:***@proxy.corp:3128");
    expect(row("GIT_SSH_COMMAND")?.value).toBe("set");
    for (const secret of ["SECRET", "hunter2", "secret_key"]) expect(text).not.toContain(secret);
  });
});

describe("findOnPath", () => {
  it("returns every match in PATH order, once each", () => {
    const executables = ["/a/git", "/c/git"];
    expect(findOnPath("git", { PATH: "/a:/b:/c:/a" }, { isExecutable: (p) => executables.includes(p) })).toEqual(["/a/git", "/c/git"]);
    expect(findOnPath("git", {}, { isExecutable: () => true })).toEqual([]);
  });
});

describe("spawnRunner timeout", () => {
  it("kills a command that runs too long and reports timedOut", async () => {
    const started = Date.now();
    const result = await spawnRunner("sleep", ["10"], { timeoutMs: 200 });
    expect(result).toMatchObject({ code: 124, timedOut: true });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("leaves fast commands alone", async () => {
    expect(await spawnRunner("sh", ["-c", "echo hi"], { timeoutMs: 5_000 })).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
  });
});
