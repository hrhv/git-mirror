import { describe, expect, it } from "vitest";
import { MirrorError } from "../../src/core/errors.js";
import {
  githubUrl,
  isPathLike,
  isRemoteUrl,
  parseDestinationInput,
  parseHostedUrl,
  parseGithubUrl,
  parseSlug,
  redactUrl,
  repoNameFromUrl,
} from "../../src/core/remote.js";

describe("isRemoteUrl", () => {
  it.each([
    "https://github.com/a/b.git",
    "ssh://git@host:2222/a/b.git",
    "file:///tmp/repo.git",
    "git@github.com:a/b.git",
    "user@gitlab.example.com:group/sub/b.git",
    "myserver:repos/app.git",
    "gitlab.example.com:group/app.git",
  ])("treats %s as a URL", (value) => expect(isRemoteUrl(value)).toBe(true));

  it.each(["owner/repo", "repo", "./repo", "/abs/path", "C:\\code\\repo", "./dir:with-colon"])("does not treat %s as a URL", (value) =>
    expect(isRemoteUrl(value)).toBe(false),
  );
});

describe("isPathLike", () => {
  it.each([".", "..", "./a", "../a/b", "/tmp/x", "~/code", "C:\\code"])("treats %s as a path", (value) =>
    expect(isPathLike(value)).toBe(true),
  );
  it.each(["owner/repo", "repo", ".github"])("does not treat %s as a path", (value) => expect(isPathLike(value)).toBe(false));
});

describe("repoNameFromUrl", () => {
  it.each([
    ["https://github.com/o/my-repo.git", "my-repo"],
    ["https://github.com/o/my-repo/", "my-repo"],
    ["git@github.com:o/my-repo.git", "my-repo"],
    ["git@host:my-repo.git", "my-repo"],
    ["/srv/git/project.git", "project"],
  ])("%s -> %s", (url, name) => expect(repoNameFromUrl(url)).toBe(name));
});

describe("redactUrl", () => {
  it.each([
    ["https://user:s3cret@gitlab.com/g/r.git", "https://user:***@gitlab.com/g/r.git"],
    ["https://ghp_abc123@github.com/o/r.git", "https://***@github.com/o/r.git"],
    ["ssh://git@host:2222/o/r.git", "ssh://git@host:2222/o/r.git"],
    ["git@github.com:o/r.git", "git@github.com:o/r.git"],
    ["https://github.com/o/r.git", "https://github.com/o/r.git"],
    ["/srv/git/r.git", "/srv/git/r.git"],
    [
      "fatal: could not read Password for 'https://ghp_x@github.com': terminal prompts disabled",
      "fatal: could not read Password for 'https://***@github.com': terminal prompts disabled",
    ],
  ])("%s -> %s", (url, expected) => expect(redactUrl(url)).toBe(expected));
});

describe("parseSlug", () => {
  it("parses repo and owner/repo, dropping a .git suffix", () => {
    expect(parseSlug("backup")).toEqual({ repo: "backup" });
    expect(parseSlug("my-org/backup.git")).toEqual({ owner: "my-org", repo: "backup" });
    expect(parseSlug("o/repo.name_1")).toEqual({ owner: "o", repo: "repo.name_1" });
  });

  it.each(["a/b/c", "-bad/repo", "owner/", "has space", ""])("rejects %j", (value) => expect(parseSlug(value)).toBeUndefined());
});

describe("parseGithubUrl", () => {
  it("extracts owner/repo from https and ssh URLs on the given host", () => {
    expect(parseGithubUrl("https://github.com/o/r.git", "github.com")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubUrl("https://token@github.com/o/r", "github.com")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubUrl("git@github.com:o/r.git", "github.com")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubUrl("ssh://git@ghe.corp.com/o/r.git", "ghe.corp.com")).toEqual({ owner: "o", repo: "r" });
  });

  it("ignores other hosts and look-alike hosts", () => {
    expect(parseGithubUrl("https://gitlab.com/o/r.git", "github.com")).toBeUndefined();
    expect(parseGithubUrl("https://githubxcom/o/r.git", "github.com")).toBeUndefined();
    expect(parseGithubUrl("https://github.com/group/sub/r.git", "github.com")).toBeUndefined();
  });
});

describe("githubUrl", () => {
  it("builds ssh and https URLs", () => {
    expect(githubUrl("github.com", "o", "r", "ssh")).toBe("git@github.com:o/r.git");
    expect(githubUrl("ghe.corp.com", "o", "r", "https")).toBe("https://ghe.corp.com/o/r.git");
  });
});

describe("parseHostedUrl", () => {
  it.each([
    ["https://gitlab.example.com/group/sub/app.git", { host: "gitlab.example.com", origin: "https://gitlab.example.com", segments: ["group", "sub", "app"] }],
    ["http://gitea.local:3000/me/app", { host: "gitea.local", origin: "http://gitea.local:3000", segments: ["me", "app"] }],
    ["https://oauth2:tok@GitLab.com/g/app.git/", { host: "gitlab.com", origin: "https://gitlab.com", segments: ["g", "app"] }],
    ["ssh://git@git.example.com:2222/team/app.git", { host: "git.example.com", origin: undefined, segments: ["team", "app"] }],
    ["git@codeberg.org:me/app.git", { host: "codeberg.org", origin: undefined, segments: ["me", "app"] }],
    ["myserver:repos/app.git", { host: "myserver", origin: undefined, segments: ["repos", "app"] }],
  ])("parses %s", (url, expected) => expect(parseHostedUrl(url)).toEqual(expected));

  it.each(["file:///tmp/repo.git", "/srv/repo.git", "./repo", "https://host.com/"])("returns undefined for %s", (url) =>
    expect(parseHostedUrl(url)).toBeUndefined(),
  );
});

describe("parseDestinationInput", () => {
  it("parses shorthand of any depth (providers validate depth later)", () => {
    expect(parseDestinationInput("backup")).toEqual({ kind: "shorthand", repo: "backup" });
    expect(parseDestinationInput("org/backup.git")).toEqual({ kind: "shorthand", namespace: "org", repo: "backup" });
    expect(parseDestinationInput("group/sub/app")).toEqual({ kind: "shorthand", namespace: "group/sub", repo: "app" });
  });

  it("separates URLs from paths", () => {
    expect(parseDestinationInput("git@github.com:org/backup.git")).toEqual({ kind: "url", url: "git@github.com:org/backup.git" });
    expect(parseDestinationInput("myserver:repos/app.git")).toEqual({ kind: "url", url: "myserver:repos/app.git" });
    expect(parseDestinationInput("../backup.git")).toEqual({ kind: "path", path: "../backup.git" });
  });

  it("rejects malformed input with a hint", () => {
    expect(() => parseDestinationInput("-bad/repo")).toThrow(MirrorError);
    expect(() => parseDestinationInput("has space")).toThrow(/Invalid destination/);
    expect(() => parseDestinationInput("  ")).toThrow(/must not be empty/);
  });
});
