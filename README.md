# git-mirror

Mirror any git repository — every branch, tag and ref — to GitHub, GitLab, Gitea/Forgejo, or any other git remote, creating the destination repository for you if it doesn't exist.

Useful for backups, moving off another git host, or keeping a private copy of an upstream project.

```bash
npx @hrhv/git-mirror . my-backup
```

## Requirements

- Node.js 22.12 or newer
- [git](https://git-scm.com/downloads)
- For GitHub destinations: the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`.
- For GitLab or Gitea/Forgejo destinations: an access token in an environment variable (see [Authentication](#authentication)). No extra CLI is needed.
- For any other destination: nothing beyond git.

## Install

The package is published to GitHub Packages, so npm needs to know where the `@hrhv` scope lives. Add this to `~/.npmrc` (use a [personal access token](https://github.com/settings/tokens) with the `read:packages` scope):

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

Once installed globally, git also picks it up as a subcommand: `git mirror <source> <destination>`.

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
| `-v, --version`             | Print the version                                                                  |

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

## Development

```bash
npm install
npm run dev -- . my-backup --dry-run   # run from source with tsx
npm test                               # vitest (unit + integration against real git)
npm run typecheck
npm run build                          # bundle to dist/ with tsup
```

The integration tests run the real `git` binary against throwaway repositories in a temp directory. They replace `gh` and the GitLab/Gitea APIs with fakes, and redirect hosted URLs to local bare repos, so they never touch the network.

### Releasing

Bump the version in `package.json`, push, and create a GitHub release. The **Publish** workflow publishes the package to GitHub Packages.

## License

MIT
