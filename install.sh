#!/bin/sh
# git-mirror installer: downloads the right prebuilt binary for this machine, verifies its checksum,
# installs it, and puts it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/hrhv/git-mirror/main/install.sh | sh
#
# Options (environment variables):
#   GIT_MIRROR_VERSION=v0.2.0       install a specific release (default: latest)
#   GIT_MIRROR_INSTALL_DIR=/opt/bin install somewhere else (default: /usr/local/bin as root, else ~/.local/bin)
#   GIT_MIRROR_NO_MODIFY_PATH=1     never edit shell profiles
#   GIT_MIRROR_DOWNLOAD_URL=...     base URL that holds the release assets (mirrors, testing)
#
# Supports Linux (glibc and musl, x64 and arm64) and macOS (Intel and Apple Silicon).
# Everything happens inside main(), called on the last line, so a partially downloaded script never runs.

set -eu

REPO="hrhv/git-mirror"
BIN_NAME="git-mirror"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m') GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') RED=$(printf '\033[31m') RESET=$(printf '\033[0m')
else
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi

info() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*" >&2; }
success() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2
  exit 1
}

has() { command -v "$1" >/dev/null 2>&1; }

detect_platform() {
  os=$(uname -s)
  cpu=$(uname -m)

  case "$cpu" in
    x86_64 | amd64) cpu=x64 ;;
    aarch64 | arm64) cpu=arm64 ;;
    *) die "Unsupported CPU architecture: $cpu (supported: x86_64, arm64)." ;;
  esac

  case "$os" in
    Darwin)
      # An x64 shell under Rosetta on Apple Silicon should still get the native arm64 build.
      if [ "$cpu" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then cpu=arm64; fi
      echo "darwin-$cpu"
      ;;
    Linux)
      libc=""
      for loader in /lib/ld-musl-*.so.1; do
        if [ -e "$loader" ]; then libc="-musl"; fi
      done
      if [ -z "$libc" ] && (ldd --version 2>&1 | grep -qi musl); then libc="-musl"; fi
      echo "linux-$cpu$libc"
      ;;
    *) die "Unsupported operating system: $os (supported: Linux, macOS). Install with npm instead: npx @hrhv/git-mirror" ;;
  esac
}

# The musl builds link libstdc++ and libgcc dynamically; Alpine doesn't ship them by default.
ensure_musl_runtime() {
  missing=""
  for lib in libstdc++.so.6 libgcc_s.so.1; do
    found=""
    for dir in /lib /usr/lib /usr/local/lib; do
      if [ -e "$dir/$lib" ]; then found=1; fi
    done
    [ -n "$found" ] || missing="$missing $lib"
  done
  [ -z "$missing" ] && return 0

  if has apk && [ "$(id -u)" = 0 ]; then
    info "Installing runtime libraries the musl build needs: libstdc++ libgcc"
    apk add --no-cache libstdc++ libgcc >/dev/null || die "apk add libstdc++ libgcc failed."
  elif has apk; then
    die "git-mirror needs libstdc++ and libgcc on Alpine. Run: sudo apk add libstdc++ libgcc  (then re-run this installer)"
  else
    die "git-mirror needs these shared libraries, which are missing:$missing. Install your distro's libstdc++ and libgcc packages."
  fi
}

# download <url> <file>
download() {
  if has curl; then
    curl --fail --silent --show-error --location --retry 3 --output "$2" "$1"
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    die "Neither curl nor wget is installed."
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif has openssl; then
    openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else
    return 1
  fi
}

release_base_url() {
  if [ -n "${GIT_MIRROR_DOWNLOAD_URL:-}" ]; then
    echo "${GIT_MIRROR_DOWNLOAD_URL%/}"
    return
  fi
  version=${GIT_MIRROR_VERSION:-latest}
  if [ "$version" = latest ]; then
    echo "https://github.com/$REPO/releases/latest/download"
  else
    case "$version" in v*) ;; *) version="v$version" ;; esac
    echo "https://github.com/$REPO/releases/download/$version"
  fi
}

default_install_dir() {
  if [ -n "${GIT_MIRROR_INSTALL_DIR:-}" ]; then
    echo "$GIT_MIRROR_INSTALL_DIR"
  elif [ "$(id -u)" = 0 ]; then
    echo /usr/local/bin
  else
    echo "$HOME/.local/bin"
  fi
}

# Adds $1 to PATH in the user's shell profile, once. Prints the file it changed (if any).
add_to_path() {
  dir=$1
  case "$dir" in "$HOME"/*) path_expr="\$HOME/${dir#"$HOME"/}" ;; *) path_expr=$dir ;; esac
  marker="# Added by the git-mirror installer"

  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" line="export PATH=\"$path_expr:\$PATH\"" ;;
    bash)
      # macOS Terminal opens login shells, which read .bash_profile rather than .bashrc.
      if [ "$(uname -s)" = Darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
      line="export PATH=\"$path_expr:\$PATH\""
      ;;
    fish)
      profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/git-mirror.fish"
      line="fish_add_path \"$dir\""
      ;;
    *) profile="$HOME/.profile" line="export PATH=\"$path_expr:\$PATH\"" ;;
  esac

  if [ -f "$profile" ] && grep -qF "$marker" "$profile"; then return 0; fi
  mkdir -p "$(dirname "$profile")"
  printf '\n%s\n%s\n' "$marker" "$line" >>"$profile"
  echo "$profile"
}

main() {
  platform=$(detect_platform)
  asset="$BIN_NAME-$platform.gz"
  base_url=$(release_base_url)
  install_dir=$(default_install_dir)

  info "Installing $BIN_NAME for $platform"
  case "$platform" in *-musl) ensure_musl_runtime ;; esac

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t git-mirror)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  download "$base_url/$asset" "$tmp/$asset" ||
    die "Could not download $base_url/$asset. Check GIT_MIRROR_VERSION, or that a release exists for $platform."

  if download "$base_url/SHA256SUMS" "$tmp/SHA256SUMS"; then
    expected=$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
    [ -n "$expected" ] || die "SHA256SUMS has no entry for $asset."
    if actual=$(sha256_of "$tmp/$asset"); then
      [ "$actual" = "$expected" ] || die "Checksum mismatch for $asset (expected $expected, got $actual). Not installing."
      info "Checksum verified"
    else
      warn "No sha256sum, shasum or openssl found; skipping checksum verification."
    fi
  else
    die "Could not download SHA256SUMS to verify the binary."
  fi

  gunzip -c "$tmp/$asset" >"$tmp/$BIN_NAME" || die "Could not decompress $asset."
  chmod +x "$tmp/$BIN_NAME"

  # Run it before installing: catches a wrong libc/CPU build instead of leaving a broken binary behind.
  if ! version=$("$tmp/$BIN_NAME" --version 2>"$tmp/run-error"); then
    die "The downloaded binary does not run on this machine ($platform): $(head -n 1 "$tmp/run-error")"
  fi

  if ! mkdir -p "$install_dir" 2>/dev/null || [ ! -w "$install_dir" ]; then
    die "Cannot write to $install_dir. Re-run with sudo, or set GIT_MIRROR_INSTALL_DIR to a directory you own."
  fi
  # Copy then rename, so a running git-mirror is never replaced with a half-written file.
  cp "$tmp/$BIN_NAME" "$install_dir/.$BIN_NAME.new"
  mv -f "$install_dir/.$BIN_NAME.new" "$install_dir/$BIN_NAME"
  if [ "$(uname -s)" = Darwin ] && has xattr; then xattr -d com.apple.quarantine "$install_dir/$BIN_NAME" 2>/dev/null || true; fi

  success "Installed $BIN_NAME $version to $install_dir/$BIN_NAME"

  case ":$PATH:" in
    *":$install_dir:"*)
      found=$(command -v "$BIN_NAME" || true)
      if [ -n "$found" ] && [ "$found" != "$install_dir/$BIN_NAME" ]; then
        warn "Another $BIN_NAME at $found comes first on your PATH and will be used instead."
      fi
      ;;
    *)
      if [ -n "${GIT_MIRROR_NO_MODIFY_PATH:-}" ]; then
        warn "$install_dir is not on your PATH. Add it to use $BIN_NAME."
      elif profile=$(add_to_path "$install_dir") && [ -n "$profile" ]; then
        success "Added $install_dir to PATH in $profile"
        info "Open a new terminal, or run: export PATH=\"$install_dir:\$PATH\""
      else
        info "$install_dir is already on PATH in your shell profile. Open a new terminal to use it."
      fi
      ;;
  esac

  has git || warn "git is not installed. $BIN_NAME needs it: https://git-scm.com/downloads"
  has gh || info "Mirroring to GitHub needs the GitHub CLI (https://cli.github.com). GitLab, Gitea and other remotes don't."

  printf '\n  %s%s . my-backup%s       mirror the current repo to a new private GitHub repo\n' "$BOLD" "$BIN_NAME" "$RESET" >&2
  printf '  %s%s --help%s               all options\n' "$BOLD" "$BIN_NAME" "$RESET" >&2
  printf '\n  To uninstall: curl -fsSL https://raw.githubusercontent.com/%s/main/uninstall.sh | sh\n\n' "$REPO" >&2
}

main "$@"
