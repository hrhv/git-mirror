import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { run, type CliDeps } from "../../src/cli/program.js";
import { createFakeRunner, createMemoryLogger, fakeGh, ok } from "../helpers/fake-runner.js";

function cli(args: string[], deps: Partial<CliDeps> = {}) {
  const fake = createFakeRunner({
    gh: fakeGh({ user: "jane" }),
    git: (gitArgs) => (gitArgs[0] === "ls-remote" ? ok("abc\trefs/heads/main") : ok()),
  });
  const log = createMemoryLogger();
  let out = "";
  let err = "";
  const exitCode = run(args, {
    runner: fake.runner,
    logger: log.logger,
    interactive: false,
    cwd: "/work",
    env: {},
    writeOut: (text) => (out += text),
    writeErr: (text) => (err += text),
    ...deps,
  });
  return { exitCode, fake, log, out: () => out, err: () => err };
}

describe("cli", () => {
  it("mirrors and exits 0", async () => {
    const t = cli(["https://gitlab.com/g/app.git", "backup", "--quiet"]);
    expect(await t.exitCode).toBe(0);
    expect(t.fake.commands("git")).toContain("push --mirror --quiet https://github.com/jane/backup.git");
  });

  it("maps flags onto mirror options", async () => {
    const t = cli(["https://gitlab.com/g/app.git", "org/backup", "--public", "-d", "My backup", "--protocol", "ssh"]);
    expect(await t.exitCode).toBe(0);
    expect(t.fake.commands("gh")).toContain("repo create org/backup --public --description My backup");
    expect(t.fake.commands("git")).toContain("push --mirror git@github.com:org/backup.git");
  });

  it("uses GH_HOST from the environment as the default host", async () => {
    const t = cli(["https://gitlab.com/g/app.git", "org/backup"], { env: { GH_HOST: "ghe.corp.com" } });
    expect(await t.exitCode).toBe(0);
    expect(t.fake.commands("gh")).toContain("auth status --hostname ghe.corp.com");
  });

  it("prints the error and hint and exits 1 on a MirrorError", async () => {
    const t = cli(["https://gitlab.com/g/app.git", "a/b/c"]);
    expect(await t.exitCode).toBe(1);
    expect(t.log.lines).toEqual([
      'error: Invalid destination "a/b/c".',
      "error: Use `repo`, `owner/repo`, or a full git URL such as git@github.com:owner/repo.git.",
    ]);
  });

  it("exits 1 with usage help when arguments are missing", async () => {
    const t = cli(["only-source"]);
    expect(await t.exitCode).toBe(1);
    expect(t.err()).toContain("missing required argument 'destination'");
    expect(t.fake.calls).toHaveLength(0);
  });

  it("rejects unknown visibility values", async () => {
    const t = cli(["a/b", "c", "--visibility", "secret"]);
    expect(await t.exitCode).toBe(1);
    expect(t.err()).toContain("Allowed choices are private, public, internal");
  });

  it("prints the version", async () => {
    const t = cli(["--version"]);
    expect(await t.exitCode).toBe(0);
    expect(t.out().trim()).toBe(pkg.version);
  });
});
