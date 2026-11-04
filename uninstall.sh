#!/bin/sh
# git-mirror uninstaller: removes what install.sh set up.
#
#   curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/uninstall.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/uninstall.sh | sh -s -- --dry-run
#
# Everything happens inside main(), called on the last line, so a partially downloaded script never runs.

set -eu

BIN_NAME="git-mirror"
MARKER="# Added by the git-mirror installer"

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--dry-run]

Removes:
  - the git-mirror binary from $GIT_MIRROR_INSTALL_DIR, ~/.local/bin, /usr/local/bin,
    or wherever it is on your PATH
  - the PATH lines install.sh added to your shell profiles
  - temporary clones left behind by interrupted git-mirror runs

Leaves alone (and tells you about): npm installs of @hrhv/git-mirror, other programs
that happen to be called git-mirror, the install directory itself, git, gh, and tokens.

Options:
  -n, --dry-run   show what would be removed without changing anything
  -h, --help      show this help
EOF
}

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m') GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') RED=$(printf '\033[31m') RESET=$(printf '\033[0m')
else
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi

info() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*" >&2; }
success() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
error() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }

DRY_RUN=""
FAILED=""
CHANGED=""
SEEN=""

# Deletes a file or directory, or only reports it with --dry-run.
remove() {
  target=$1
  what=$2
  if [ -n "$DRY_RUN" ]; then
    info "Would remove $what"
  elif rm -rf "$target" 2>/dev/null && [ ! -e "$target" ] && [ ! -L "$target" ]; then
    success "Removed $what"
    CHANGED=1
  else
    error "Could not remove $what."
    FAILED=1
  fi
}

# Is this file the git-mirror built from this project (not an npm shim or another tool with the same name)?
is_our_binary() {
  [ -f "$1" ] || return 1
  if "$1" --help 2>/dev/null | grep -q 'GIT_MIRROR_TOKEN'; then return 0; fi
  # Can't run it (e.g. a musl build missing its libraries): look for a string only this project contains.
  # -a: treat the binary as text (some greps skip binary files otherwise).
  LC_ALL=C grep -a -q 'GIT_MIRROR_TOKEN' "$1" 2>/dev/null
}

is_npm_install() {
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in *node_modules*) return 0 ;; esac
  return 1
}

check_binary() {
  path=$1
  case "$path" in /*) ;; *) return 0 ;; esac
  # Each path once, even if it is both an install location and the one on PATH.
  case "
$SEEN
" in *"
$path
"*) return 0 ;; esac
  SEEN="$SEEN
$path"

  # Leftover from an interrupted install (install.sh copies to .git-mirror.new, then renames).
  partial="$(dirname "$path")/.$BIN_NAME.new"
  if [ -f "$partial" ]; then remove "$partial" "unfinished install $partial"; fi

  [ -e "$path" ] || [ -L "$path" ] || return 0
  FOUND=1

  if is_npm_install "$path"; then
    warn "$path was installed with npm. Remove it with: npm uninstall -g @hrhv/git-mirror"
  elif ! is_our_binary "$path"; then
    warn "$path is not this project's git-mirror; leaving it alone."
  elif [ -z "$DRY_RUN" ] && [ ! -w "$(dirname "$path")" ]; then
    error "No permission to remove $path. Run: sudo rm \"$path\""
    FAILED=1
  else
    remove "$path" "$path"
  fi
}

# Prints the profile without install.sh's block: the marker, the PATH line right after it, and the blank line
# install.sh put before the marker. The marker is only removed together with a PATH line that looks like ours.
strip_block() {
  awk -v marker="$MARKER" '
    { lines[NR] = $0 }
    END {
      out = 0
      for (i = 1; i <= NR; i++) {
        if (lines[i] == marker && i < NR && lines[i + 1] ~ /^(export PATH=|fish_add_path )/) {
          if (out > 0 && kept[out] == "") out--
          i++
          continue
        }
        kept[++out] = lines[i]
      }
      for (j = 1; j <= out; j++) print kept[j]
    }
  ' "$1"
}

clean_profile() {
  profile=$1
  [ -f "$profile" ] || return 0
  grep -qF "$MARKER" "$profile" || return 0
  case "
$SEEN
" in *"
$profile
"*) return 0 ;; esac
  SEEN="$SEEN
$profile"

  if [ -n "$DRY_RUN" ]; then
    info "Would remove the git-mirror PATH line from $profile"
    return 0
  fi
  if [ ! -w "$profile" ]; then
    error "No permission to edit $profile. Remove the lines after \"$MARKER\" yourself."
    FAILED=1
    return 0
  fi

  stripped=$(mktemp 2>/dev/null || mktemp -t git-mirror-profile)
  strip_block "$profile" >"$stripped"
  if [ -s "$stripped" ]; then
    # Write in place (not mv) so the file keeps its permissions and owner, and a symlink stays a symlink.
    cat "$stripped" >"$profile"
    success "Removed the git-mirror PATH line from $profile"
  else
    # The installer created this file and nothing else was ever added to it.
    rm -f "$profile"
    success "Removed $profile (it only contained the git-mirror PATH line)"
  fi
  rm -f "$stripped"
  CHANGED=1
}

main() {
  for arg in "$@"; do
    case "$arg" in
      -n | --dry-run) DRY_RUN=1 ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        error "Unknown option: $arg"
        usage >&2
        exit 2
        ;;
    esac
  done
  [ -n "$DRY_RUN" ] && info "Dry run: nothing will be changed."

  # 1. Binaries: every location install.sh uses, then whatever (still) answers to git-mirror on PATH.
  FOUND=""
  if [ -n "${GIT_MIRROR_INSTALL_DIR:-}" ]; then check_binary "$GIT_MIRROR_INSTALL_DIR/$BIN_NAME"; fi
  check_binary "$HOME/.local/bin/$BIN_NAME"
  check_binary "/usr/local/bin/$BIN_NAME"
  check_binary "$(command -v "$BIN_NAME" 2>/dev/null || true)"
  [ -n "$FOUND" ] || info "No git-mirror binary found in the install locations or on PATH."

  # 2. Shell profiles (the same files install.sh may have edited).
  for profile in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    clean_profile "$profile"
  done
  fish_conf="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/git-mirror.fish"
  if [ -f "$fish_conf" ] && grep -qF "$MARKER" "$fish_conf"; then remove "$fish_conf" "$fish_conf"; fi

  # 3. Temporary clones (git-mirror-XXXXXX/repo.git) from runs killed before they could clean up. Ours only.
  tmp_root=${TMPDIR:-/tmp}
  for dir in "${tmp_root%/}"/git-mirror-*; do
    [ -d "$dir/repo.git" ] || continue
    [ -n "$(find "$dir" -prune -user "$(id -u)" 2>/dev/null)" ] || continue
    remove "$dir" "leftover temporary clone $dir"
  done

  echo >&2
  if [ -n "$FAILED" ]; then
    error "git-mirror was only partly removed; see the messages above."
    exit 1
  elif [ -n "$DRY_RUN" ]; then
    info "Dry run complete. Run without --dry-run to remove the items above."
  elif [ -n "$CHANGED" ]; then
    success "git-mirror has been uninstalled. Open a new terminal to refresh your PATH."
  else
    info "Nothing to remove: git-mirror is not installed on this machine by install.sh."
  fi
}

main "$@"
