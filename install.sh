#!/bin/bash
# ShowRoom installer (also updates an existing install):
#   curl -fsSL https://raw.githubusercontent.com/ccorrada/showroom/main/install.sh | bash
# Clones ShowRoom into ~/.showroom/app, installs the LaunchAgent and opens the page.
# Overrides: SHOWROOM_DIR (where the code goes), SHOWROOM_REPO (where it's cloned from).
set -euo pipefail

# Everything runs inside main, so a partially downloaded script does nothing.
main() {
  local repo="${SHOWROOM_REPO:-https://github.com/ccorrada/showroom.git}"
  local dir="${SHOWROOM_DIR:-$HOME/.showroom/app}"

  say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
  fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

  [ "$(uname -s)" = "Darwin" ] || fail "ShowRoom runs on macOS only."
  xcode-select -p >/dev/null 2>&1 && command -v git >/dev/null 2>&1 ||
    fail "git is missing. Run: xcode-select --install, then run this installer again."
  command -v node >/dev/null 2>&1 ||
    fail "Node.js is missing. Install Node.js 20.12 or newer (brew install node, or https://nodejs.org), then run this again."
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' ||
    fail "Node.js $(node -v) is too old. ShowRoom needs 20.12 or newer (brew upgrade node)."

  if [ -d "$dir/.git" ]; then
    say "Updating ShowRoom in $dir"
    git -C "$dir" pull --ff-only --quiet
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    fail "$dir already exists and isn't a ShowRoom checkout. Move it away or set SHOWROOM_DIR."
  else
    say "Downloading ShowRoom into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet --depth 1 "$repo" "$dir"
  fi

  say "Installing the LaunchAgent (starts ShowRoom at login)"
  node "$dir/src/agent.mjs" install >/dev/null

  # Port and project folders, as ShowRoom itself resolves them.
  local info port
  info="$(cd "$dir" && node --input-type=module -e '
    const { CONFIG: c } = await import("./src/config.mjs");
    console.log(c.port);
    console.log(c.roots.length ? `Projects from: ${c.roots.join(", ")}` : "No project folders found yet: the page will show you how to set them.");')"
  port="$(printf '%s\n' "$info" | head -1)"
  say "$(printf '%s\n' "$info" | tail -1)"

  local url="http://localhost:$port"
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "$url/" 2>/dev/null && break
    sleep 0.5
  done
  if curl -fsS -o /dev/null "$url/" 2>/dev/null; then
    say "ShowRoom is running → $url"
    open "$url"
  else
    say "Installed, but the server didn't answer yet. Check $HOME/.showroom/server.log, then open $url"
  fi

  cat <<EOF

  Settings:  $HOME/.showroom/config.json   (e.g. { "roots": ["~/Projects"] })
  Update:    run this installer again
  Uninstall: node "$dir/src/agent.mjs" uninstall && rm -rf "$dir"
             (your edits, links and images stay in ~/.showroom; delete that folder to remove everything)
EOF
}

main "$@"
