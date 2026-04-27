#!/usr/bin/env bash
# fleet — one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gkkirsch/fleet/main/install.sh | bash
#
# Downloads the latest release of each of the four binaries
# (amux, camux, roster, fleetview) for darwin arm64/amd64 from GitHub
# Releases and drops them into ~/.local/bin. Bails loudly if a prereq
# is missing — better to fail fast than half-install.
#
# Prereqs (you install these yourself):
#   - tmux 3.x          brew install tmux
#   - node 20+          brew install node     (for `agent-browser`)
#   - claude            npm i -g @anthropic-ai/claude-code (then run `claude` once to log in)
set -euo pipefail

REPO_OWNER="gkkirsch"
INSTALL_DIR="${HOME}/.local/bin"

c_dim() { printf "\033[2m%s\033[0m\n" "$*"; }
c_ok()  { printf "\033[32m✓\033[0m %s\n" "$*"; }
c_arr() { printf "\033[36m↓\033[0m %s\n" "$*"; }
c_err() { printf "\033[31m✗\033[0m %s\n" "$*" >&2; }
die()   { c_err "$1"; exit 1; }

# ── platform ──────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) os="darwin" ;;
  *) die "fleet currently supports macOS only (got $(uname -s)). Linux support is on the roadmap." ;;
esac
case "$(uname -m)" in
  arm64)  arch="arm64" ;;
  x86_64) arch="amd64" ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac
c_ok "macOS / $arch"

# ── prereqs ───────────────────────────────────────────────────────────
need() { command -v "$1" >/dev/null 2>&1 || die "$2"; }
need tmux   "tmux not found. Install with: brew install tmux"
need node   "node not found. Install with: brew install node"
need npm    "npm not found. Install Node.js (which bundles npm)."
need claude "claude (Claude Code CLI) not found. Install with: npm i -g @anthropic-ai/claude-code"

if ! /usr/bin/security find-generic-password -s "Claude Code-credentials" -a "$USER" -w >/dev/null 2>&1; then
  die "Claude Code is installed but not logged in. Run \`claude\` once and complete the login flow, then re-run this installer."
fi

c_ok "tmux $(tmux -V | awk '{print $2}')"
c_ok "node $(node -v)"
c_ok "claude code authenticated"

mkdir -p "$INSTALL_DIR"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *) c_dim "  note: ${INSTALL_DIR} is not on your PATH yet — add this to your shell rc:"
     c_dim "        export PATH=\"\$HOME/.local/bin:\$PATH\""
     ;;
esac

# ── download each binary's latest release ─────────────────────────────
download_binary() {
  local repo="$1" binary="$2"
  local archive="${repo}_${os}_${arch}.tar.gz"
  local url="https://github.com/${REPO_OWNER}/${repo}/releases/latest/download/${archive}"
  local tmp; tmp="$(mktemp -d)"
  c_arr "${binary}"
  if ! curl -fsSL "$url" -o "${tmp}/${archive}"; then
    die "Failed to download $url"
  fi
  tar -xzf "${tmp}/${archive}" -C "$tmp"
  if [[ ! -x "${tmp}/${binary}" ]]; then
    die "Archive for ${repo} did not contain expected binary '${binary}'"
  fi
  install -m 0755 "${tmp}/${binary}" "${INSTALL_DIR}/${binary}"
  rm -rf "$tmp"
}

# (repo, binary-name) — fleet is the only one where they differ.
download_binary amux   amux
download_binary camux  camux
download_binary roster roster
download_binary fleet  fleetview

# ── agent-browser (npm global) ────────────────────────────────────────
if ! command -v agent-browser >/dev/null 2>&1; then
  c_arr "agent-browser (via npm)"
  npm install -g --silent agent-browser
fi
c_ok "agent-browser installed"

# ── done ──────────────────────────────────────────────────────────────
echo
c_ok "Installed to ${INSTALL_DIR}: amux camux roster fleetview"
echo
cat <<EOF
Next steps:

  1. Start the dashboard:
     fleetview &

  2. Open http://localhost:8080

  3. Spawn your first dispatcher:
     roster spawn dispatch --kind dispatcher --description "routes user requests"

  4. From the dashboard, message dispatch — it will spawn whatever
     orchestrator the work needs.

EOF
