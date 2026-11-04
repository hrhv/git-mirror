# git-mirror

Mirror any git repository — every branch, tag and ref — into a GitHub repository, creating the destination for you if it doesn't exist.

Useful for backups, moving off another git host, or keeping a private copy of an upstream project.

```bash
npx @hrhv/git-mirror . my-backup
```

## Requirements

- Node.js 22.12 or newer
- [git](https://git-scm.com/downloads)
- [GitHub CLI](https://cli.github.com), logged in with `gh auth login`. `gh` is only needed when the destination is on GitHub, and it handles all authentication.

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

| Form                | Behaviour                                                         |
| ------------------- | ----------------------------------------------------------------- |
| `repo`              | `<your GitHub username>/repo`, created if missing                 |
| `owner/repo`        | That user or organization's repo, created if missing              |
| GitHub URL          | Same as `owner/repo`, but pushes to exactly the URL you gave      |
| Any other git URL   | Pushed to as-is (the repo must already exist)                     |
| Local path          | A bare repository on disk (must already exist)                    |

### Examples

```bash
# Back up the repo you're in to a new private repo on your account
git-mirror . my-backup

# Copy a GitLab project into a GitHub organization, as a public repo
git-mirror https://gitlab.com/group/app.git my-org/app --public

# Mirror a GitHub repo into your org on GitHub Enterprise Server
git-mirror https://github.com/vercel/next.js platform/next-mirror --host github.example.com

# Push to a non-GitHub remote
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
| `--host <hostname>`         | GitHub host for GitHub Enterprise Server (default: `$GH_HOST` or `github.com`)     |
| `--protocol <ssh\|https>`   | Protocol for GitHub URLs (default: your `gh config get git_protocol` setting)      |
| `--no-create`               | Fail instead of creating a missing destination repo                                |
| `-f, --force`               | Overwrite a destination that already has content without asking                    |
| `-n, --dry-run`             | Show what would happen without creating or pushing anything                        |
| `--keep-pull-refs`          | Also push `refs/pull/*` (GitHub rejects these; only useful for other hosts)        |
| `-q, --quiet`               | Only print warnings and errors                                                     |
| `-v, --version`             | Print the version                                                                  |

## How it works

1. Checks the source with `git ls-remote`. It stops here if the source is unreachable, private without credentials, or empty.
1. Resolves the destination. For GitHub destinations it uses `gh` to find your username, your preferred protocol, and whether the repo exists, and creates it if needed.
2. Checks the destination. If it already has branches or tags, git-mirror asks before continuing, or fails when not running in a terminal, unless you pass `--force`. A mirror push **replaces every ref** and deletes branches and tags that aren't in the source.
3. Runs `git clone --mirror` into a temporary directory.
4. Removes `refs/pull/*`. GitHub creates these for pull requests and rejects any push that includes them.
5. Runs `git push --mirror`, then deletes the temporary directory, even if the push failed.

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

The integration tests run the real `git` binary against throwaway repositories in a temp directory. They replace `gh` with a fake and redirect GitHub URLs to local bare repos, so they never touch the network.

### Releasing

Bump the version in `package.json`, push, and create a GitHub release. The **Publish** workflow publishes the package to GitHub Packages.

## License

MIT
