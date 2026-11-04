import { MirrorError } from "./errors.js";
import type { Runner } from "./exec.js";
import type { GitConfig } from "./providers/types.js";
import { isRemoteUrl, redactUrl } from "./remote.js";

export class Git {
  constructor(
    private readonly run: Runner,
    private readonly quiet = false,
  ) {}

  async assertInstalled(): Promise<void> {
    const result = await this.run("git", ["--version"]);
    if (result.code !== 0) throw new MirrorError("`git --version` failed. Is git installed correctly?");
  }

  /** The top-level directory name of a work tree, or the directory name of a bare repo. Undefined if not a repo. */
  async repoName(path: string): Promise<string | undefined> {
    const gitDir = await this.run("git", ["-C", path, "rev-parse", "--absolute-git-dir"]);
    if (gitDir.code !== 0) return undefined;

    const topLevel = await this.run("git", ["-C", path, "rev-parse", "--show-toplevel"]);
    const dir = topLevel.code === 0 && topLevel.stdout.trim() ? topLevel.stdout.trim() : gitDir.stdout.trim();
    const name = dir.split(/[\\/]/).pop() ?? dir;
    return name.replace(/\.git$/, "");
  }

  /** Whether the remote has any refs. Throws when the remote cannot be reached. */
  async hasRefs(url: string, { gitConfig, hint }: { gitConfig?: GitConfig; hint?: string } = {}): Promise<boolean> {
    const result = await this.run("git", ["ls-remote", url], { gitConfig });
    if (result.code !== 0) {
      const reason = lastLine(result.stderr);
      throw new MirrorError(`Cannot read destination ${redactUrl(url)}${reason ? `: ${reason}` : "."}`, hint);
    }
    return result.stdout.trim().length > 0;
  }

  /**
   * Checks the source can be read and has something to mirror, before anything is created.
   * Uses the same credentials (SSH keys, credential helpers) as the clone will.
   */
  async assertReadableSource(url: string): Promise<void> {
    const result = await this.run("git", ["ls-remote", url]);
    if (result.code !== 0) {
      const reason = lastLine(result.stderr);
      throw new MirrorError(
        `Cannot read source ${redactUrl(url)}${reason ? `: ${reason}` : "."}`,
        isRemoteUrl(url) ? accessHint(url) : undefined,
      );
    }
    if (!result.stdout.trim()) {
      throw new MirrorError(`Source ${redactUrl(url)} has no branches or tags to mirror.`);
    }
  }

  async cloneMirror(url: string, dir: string): Promise<void> {
    const args = ["clone", "--mirror", ...(this.quiet ? ["--quiet"] : []), url, dir];
    const result = await this.run("git", args, { stream: !this.quiet });
    if (result.code !== 0) throw new MirrorError(`Failed to clone ${redactUrl(url)}.`, lastLine(result.stderr));
  }

  /** Deletes every ref under the given prefixes (e.g. `refs/pull/`). Returns how many were removed. */
  async deleteRefs(dir: string, prefixes: string[]): Promise<number> {
    if (prefixes.length === 0) return 0;
    const list = await this.run("git", ["for-each-ref", "--format=%(refname)", ...prefixes], { cwd: dir });
    if (list.code !== 0) throw new MirrorError("Failed to list refs.", firstLine(list.stderr));

    const refs = list.stdout.split("\n").filter(Boolean);
    if (refs.length === 0) return 0;

    const input = refs.map((ref) => `delete ${ref}\n`).join("");
    const result = await this.run("git", ["update-ref", "--stdin"], { cwd: dir, input });
    if (result.code !== 0) throw new MirrorError("Failed to remove excluded refs.", firstLine(result.stderr));
    return refs.length;
  }

  async pushMirror(dir: string, url: string, gitConfig?: GitConfig): Promise<void> {
    const args = ["push", "--mirror", ...(this.quiet ? ["--quiet"] : []), url];
    const result = await this.run("git", args, { cwd: dir, stream: !this.quiet, gitConfig });
    if (result.code !== 0) throw new MirrorError(`Failed to push to ${redactUrl(url)}.`, lastLine(result.stderr));
  }
}

function firstLine(text: string): string | undefined {
  return text.trim().split("\n").find(Boolean);
}

/** git puts the actual reason last ("fatal: ..."), after remote chatter. Credentials in it are redacted. */
function lastLine(text: string): string | undefined {
  const line = text.trim().split("\n").filter(Boolean).pop()?.trim();
  return line && redactUrl(line);
}

function accessHint(url: string): string {
  return /^(https?):\/\//i.test(url)
    ? "Check the URL. For private repos, set up git credentials (for GitHub: `gh auth setup-git`) or use the SSH URL."
    : "Check the URL and that your SSH key has access (try `ssh -T` against the host).";
}
