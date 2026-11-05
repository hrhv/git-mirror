# git-mirror

Mirror any git repository — every branch, tag and ref — to GitHub, GitLab, Gitea/Forgejo, or any other git remote, creating the destination repository for you if it doesn't exist.

Useful for backups, moving off another git host, or keeping a private copy of an upstream project.

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
git-mirror . my-backup
```

## Requirements

- [git](https://git-scm.com/downloads)
- Node.js 22.12 or newer, only if you install through npm. The standalone binary has no other dependencies.
- For GitHub destinations: the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`.
- For GitLab or Gitea/Forgejo destinations: an access token in an environment variable (see [Authentication](#authentication)). No extra CLI is needed.
- For any other destination: nothing beyond git.

## Install

### Standalone binary (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
```

or, with wget:

```bash
wget -qO- https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
```

The installer:

1. Picks the build for your machine: Linux (glibc or musl/Alpine, x64 or arm64), or macOS (Intel or Apple Silicon).
2. Downloads it from the [latest release](https://github.com/hrhv/git-mirror/releases/latest), or the newest pre-release if there's no stable release yet, and verifies it against `SHA256SUMS`.
3. Runs it once to make sure it works on this machine, then installs it to `~/.local/bin`, or to `/usr/local/bin` when run as root.
4. Adds that directory to your `PATH` in your shell profile (`~/.zshrc`, `~/.bashrc`, `~/.bash_profile` on macOS, fish's `conf.d`, or `~/.profile`), unless it's already on your `PATH`.

Every step is announced before it runs, and the download shows a progress bar. Each transfer has timeouts and gives up if it stalls, so the installer can't hang silently. To see everything it does (each URL with its HTTP status, size and duration, the checksums, and the time spent on every step), run it with `--verbose`:

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh -s -- --verbose
```

Running it again upgrades to the latest version. You can customise it with environment variables:

| Variable | Effect |
| -------- | ------ |
| `GIT_MIRROR_VERSION=v0.2.0` | Install a specific release instead of the latest (the leading `v` is optional) |
| `GIT_MIRROR_INSTALL_DIR=/opt/bin` | Install somewhere else |
| `GIT_MIRROR_NO_MODIFY_PATH=1` | Don't edit any shell profile |
| `GIT_MIRROR_VERBOSE=1` | Same as `--verbose` (below) |

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | GIT_MIRROR_VERSION=v0.2.0 sh
```

In a Dockerfile:

```dockerfile
# Debian/Ubuntu
RUN apt-get update && apt-get install -y git curl && curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
# Alpine (the musl build also needs libstdc++ and libgcc; as root the installer adds them itself)
RUN apk add --no-cache git curl && curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
```

You can also download a binary yourself from the [releases page](https://github.com/hrhv/git-mirror/releases). Each one is gzipped, so run `gunzip` on it, `chmod +x` it, and put it on your `PATH`.

#### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/uninstall.sh | sh
```

Add `sh -s -- --dry-run` in place of `sh` to see what would be removed first. The uninstaller removes:

- the binary, from `$GIT_MIRROR_INSTALL_DIR`, `~/.local/bin`, `/usr/local/bin`, or wherever it is on your `PATH`
- the `PATH` lines the installer added to your shell profiles. Everything else in those files stays exactly as it was, and a symlinked profile stays a symlink.
- temporary clones left in `$TMPDIR` by interrupted runs

It verifies that a binary really is this project's before deleting it. It won't touch an npm install of `@hrhv/git-mirror` (it tells you to run `npm uninstall -g @hrhv/git-mirror`), another program that happens to be called `git-mirror`, or git, gh, and your tokens. If the binary is in a directory you can't write to, it prints the `sudo rm` command to run.

### npm

The package is published to GitHub Packages, which needs authentication even for public packages. Tell npm where the `@hrhv` scope lives in `~/.npmrc`, using a [personal access token](https://github.com/settings/tokens) with the `read:packages` scope:

```ini
@hrhv:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_TOKEN
```

Then run it with npx, or install it globally:

```bash
npx @hrhv/git-mirror <source> <destination>
```

```bash
npm install -g @hrhv/git-mirror
```

However you install it, git also picks it up as a subcommand: `git mirror <source> <destination>`.

## Usage

```
git-mirror [options] <source> <destination>
```

**`<source>`** can be any of:

| Form                | Example                               |
| ------------------- | ------------------------------------- |
| Local path          | `.`, `../app`, `/srv/git/app.git`     |
| HTTPS URL           | `https://gitlab.com/group/app.git`    |
| SSH URL             | `git@gitlab.com:group/app.git`, `ssh://git@git.example.com:2222/team/app.git` |
| SSH config alias    | `myserver:repos/app.git` (a `Host` from `~/.ssh/config`) |
| GitHub `owner/repo` | `vercel/next.js`                      |

URL sources work with any git host and use your existing git credentials (SSH keys, credential helpers). Before anything is created, git-mirror checks that the source can be read and isn't empty, so a typo or missing access never leaves an empty repo behind. Credentials embedded in a URL (`https://user:token@host/...`) are masked in all output.

**`<destination>`** can be any of:

| Form                       | Behaviour                                                                         |
| -------------------------- | --------------------------------------------------------------------------------- |
| `repo`                     | `<your username>/repo` on the provider (GitHub by default), created if missing    |
| `owner/repo`               | That user or organization's repo, created if missing                              |
| `group/subgroup/repo`      | A project in a GitLab subgroup (with `--provider gitlab`), created if missing     |
| GitHub, GitLab or Gitea URL | Same as the shorthand, but pushes to exactly the URL you gave                    |
| Any other git URL          | Pushed to as-is (the repo must already exist)                                     |
| Local path                 | A bare repository on disk (must already exist)                                    |

### Providers

git-mirror can look up and create repositories on three kinds of hosts:

| Provider | Hosts | How repos are created | Detected automatically for |
| -------- | ----- | --------------------- | -------------------------- |
| `github` | GitHub, GitHub Enterprise Server | `gh` CLI | `github.com`, `$GH_HOST` |
| `gitlab` | GitLab.com, self-managed GitLab | REST API v4 + token | `gitlab.com`, `$GITLAB_HOST` |
| `gitea`  | Gitea, Forgejo, Codeberg | REST API v1 + token | `codeberg.org`, `$GITEA_HOST` |

A URL on any other host is a plain remote unless you pass `--provider`. Shorthand destinations (`owner/repo`) use GitHub unless you pass `--provider`, and then use `--host`, or the provider's default host.

## Authentication

Mirroring needs two kinds of access, and they're configured separately.

**1. git access (clone and push).** This works exactly like any other git command, with nothing specific to git-mirror:

| Method | Example | Notes |
| ------ | ------- | ----- |
| SSH key | `git@gitlab.example.com:team/app.git` | Add your key in the host's settings. Custom ports (`ssh://git@host:2222/...`) and `~/.ssh/config` aliases work too. |
| HTTPS + credential helper | `https://gitlab.example.com/team/app.git` | macOS Keychain, Git Credential Manager, `gh auth setup-git`, `glab auth setup-git`, etc. |
| HTTPS + token from git-mirror | `https://gitlab.example.com/team/app.git` | For GitLab and Gitea destinations, git-mirror sends the API token (below) as HTTP auth on the push, so a token alone is enough, which suits CI. It's passed through `GIT_CONFIG_*` environment variables and never appears in URLs, the process list, or logs. |
| Token in URL | `https://oauth2:<token>@gitlab.com/...` | Works anywhere and is masked in git-mirror's output, but it ends up in your shell history. Prefer the options above. |

**2. API access (only to look up and create repos).**

| Provider | Credential | Scopes |
| -------- | ---------- | ------ |
| GitHub | `gh auth login` | handled by `gh` |
| GitLab | `GITLAB_TOKEN` (personal, group or project access token) | `api` |
| Gitea / Forgejo | `GITEA_TOKEN` or `FORGEJO_TOKEN` | `write:repository`, `read:user`, and `write:organization` for org repos |

`GIT_MIRROR_TOKEN` takes precedence over the provider-specific variables. Tokens are read only from the environment, never from flags, so they stay out of shell history.

If a GitLab or Gitea URL is detected but no token is set, git-mirror still pushes, treating the destination as a plain remote that must already exist, and tells you which variable to set so it can create repos.

### Examples

```bash
# Back up the repo you're in to a new private repo on your account
git-mirror . my-backup

# Copy a GitLab project into a GitHub organization, as a public repo
git-mirror https://gitlab.com/group/app.git my-org/app --public

# Mirror a GitHub repo into your org on GitHub Enterprise Server
git-mirror https://github.com/vercel/next.js platform/next-mirror --host github.example.com

# Mirror into a GitLab subgroup on a self-managed instance (token only, no other setup)
GITLAB_TOKEN=glpat-... git-mirror . platform/backups/app --provider gitlab --host gitlab.example.com

# Mirror to a self-hosted Gitea/Forgejo, given its URL
GITEA_TOKEN=... git-mirror https://github.com/vercel/next.js https://gitea.example.com/mirrors/next.js.git --provider gitea

# Gitea on a non-standard port, over SSH, with the API on another address
git-mirror . ssh://git@gitea.lan:2222/me/app.git --provider gitea --api-url http://gitea.lan:3000

# Push to any other existing remote (the repo must exist)
git-mirror ./app git@bitbucket.org:me/app.git

# See what would happen first
git-mirror . my-backup --dry-run
```

### Options

| Option                      | Description                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `--visibility <visibility>` | `private` (default), `public` or `internal`, for a newly created repo              |
| `--public`                  | Shorthand for `--visibility public`                                                |
| `-d, --description <text>`  | Description for a newly created repo (default: `Mirror of <source>`)               |
| `--provider <provider>`     | `github`, `gitlab` or `gitea` (Gitea also covers Forgejo). Default: detected from the URL, otherwise `github` |
| `--host <hostname>`         | Host for shorthand destinations. Default: `$GH_HOST` or `github.com`; with `--provider gitlab`, `$GITLAB_HOST` or `gitlab.com`; with `--provider gitea`, `$GITEA_HOST` (required) |
| `--api-url <url>`           | GitLab/Gitea API address when it isn't `https://<host>`, e.g. `http://gitea.lan:3000` |
| `--protocol <ssh\|https>`   | Protocol for URLs built from shorthand. Default: your `gh` `git_protocol` setting on GitHub, `https` elsewhere |
| `--no-create`               | Fail instead of creating a missing destination repo                                |
| `-f, --force`               | Overwrite a destination that already has content without asking                    |
| `-n, --dry-run`             | Show what would happen without creating or pushing anything                        |
| `--keep-host-refs`          | Also push host-generated refs (`refs/pull/*`, `refs/merge-requests/*`, ...). Most hosts reject these |
| `-q, --quiet`               | Only print warnings and errors                                                     |
| `-v, --info`                | Show version, install, platform, dependency and configuration details (see [Troubleshooting](#troubleshooting)) |
| `-V, --version`             | Print just the version number                                                      |

## How it works

1. Resolves the destination's provider and checks your credentials: `gh` for GitHub, a token for GitLab/Gitea. Plain remotes skip this step.
2. Checks the source with `git ls-remote`. It stops here if the source is unreachable, private without credentials, or empty.
3. Creates the destination repo through the provider if it's missing.
4. Checks the destination. If it already has branches or tags, git-mirror asks before continuing, or fails when not running in a terminal, unless you pass `--force`. A mirror push **replaces every ref** and deletes branches and tags that aren't in the source.
5. Runs `git clone --mirror` into a temporary directory.
6. Removes refs that hosts generate for pull and merge requests and CI: `refs/pull/*` (GitHub, Gitea), `refs/merge-requests/*`, `refs/pipelines/*`, `refs/keep-around/*` and `refs/environments/*` (GitLab). These aren't project history, and hosts reject pushes that include them.
7. Runs `git push --mirror`, then deletes the temporary directory, even if the push failed.

Re-running the same command with `--force` brings an existing mirror up to date.

### Limitations

- Git LFS objects are not copied. Run `git lfs fetch --all` and `git lfs push --all` separately if the source uses LFS.
- Only git data is mirrored. Issues, pull requests, wikis and releases are not.

## Troubleshooting

`git-mirror -v` prints everything needed to debug a problem, and nothing secret:

```
git-mirror 0.1.0-alpha.1

git-mirror
    install              standalone binary
    runtime              Bun 1.3.14
    executable           ~/.local/bin/git-mirror
  ✓ on PATH              ~/.local/bin/git-mirror

System
    os                   macOS 26.4 (25E246), Darwin 25.4.0
    arch                 arm64
    ...

Dependencies
  ✓ git                  2.50.1 (Apple Git-155)  /usr/bin/git
      credential helper  osxkeychain
  ✓ gh                   2.79.0 (2025-09-08)  /opt/homebrew/bin/gh
  ✓   auth               logged in to github.com as jane
      git_protocol       ssh
  ✓ ssh                  OpenSSH_10.2p1, LibreSSL 3.3.6

Configuration
    GH_HOST              not set
    GITLAB_TOKEN         set
    ...

No problems found.
```

It shows:

- **git-mirror:** how it was installed and where, plus every `git-mirror` on your `PATH`, which catches an old copy shadowing a new one.
- **System:** the OS and version (the Linux distro, or the macOS version and build), CPU and Rosetta, libc (glibc version or musl), shell, terminal and temp directory.
- **Dependencies:** git (version, path, credential helper), gh (version, login status for `$GH_HOST`, `git_protocol`) and ssh.
- **Configuration:** the host variables, whether each token variable is set (never its value), proxy settings with any credentials masked, and git overrides such as `GIT_SSH_COMMAND`.
- **Problems:** a summary of anything that needs fixing.

Paths under your home directory are shortened to `~`, and every check has a time limit, so the command always finishes quickly. When reporting a bug, include this output. For installer problems, include the output of the installer's `--verbose` mode too.

## Development

```bash
npm install
npm run dev -- . my-backup --dry-run   # run from source with tsx
npm test                               # vitest (unit + integration against real git)
npm run typecheck
npm run build                          # bundle to dist/ with tsup
npm run smoke                          # end-to-end smoke test of the bundle

# Standalone binaries (needs Bun: https://bun.sh)
npm run build:bin                      # every platform, cross-compiled into dist/bin/
npm run build:bin -- host              # just this machine
sh scripts/smoke-test.sh dist/bin/git-mirror-darwin-arm64
```

The integration tests run the real `git` binary against throwaway repositories in a temp directory. They replace `gh` and the GitLab/Gitea APIs with fakes, and redirect hosted URLs to local bare repos, so they never touch the network.

### Releasing

1. Bump the version in `package.json`, and push.
2. Create a GitHub release whose tag matches the version, with or without a leading `v` (`0.2.0` or `v0.2.0` for version `0.2.0`). Tick **Set as a pre-release** for versions like `0.2.0-alpha.1`.

Two workflows then run:

- **Publish** publishes the npm package to GitHub Packages. Pre-releases go to the `next` dist-tag, so `npm install @hrhv/git-mirror` keeps getting the latest stable version.
- **Release binaries** builds the six binaries, each on its own OS and CPU (using Alpine containers for musl), and smoke-tests every one natively. Only if they all pass does it attach them to the release, along with `SHA256SUMS`, `install.sh` and `uninstall.sh`. A tag that doesn't match `package.json` fails the run.

To attach binaries to an existing release, run **Release binaries** manually with that tag.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
