#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="$HOME/.pi"
AGENT_DIR="$PI_DIR/agent"
SETTINGS="$AGENT_DIR/settings.json"

for bin in jq pi; do
  command -v "$bin" >/dev/null || { echo "bootstrap: $bin not found on PATH" >&2; exit 1; }
done

mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/agents"

install_package() {
  if [ -f "$SETTINGS" ] && jq -e --arg p "$1" '(.packages // []) | index($p)' "$SETTINGS" >/dev/null; then
    echo "bootstrap: already installed: $1"
  else
    pi install "$1"
  fi
}

json_merge() {
  local file="$1" filter="$2" tmp
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || printf '{}\n' >"$file"
  tmp="$(mktemp)"
  jq "$filter" "$file" >"$tmp"
  mv "$tmp" "$file"
}

for legacy in npm:pi-mcp-adapter npm:pi-web-access npm:pi-vetter; do
  if [ -f "$SETTINGS" ] && jq -e --arg p "$legacy" '(.packages // []) | index($p)' "$SETTINGS" >/dev/null; then
    pi remove "$legacy"
  fi
done
(cd "$REPO" && pnpm install --frozen-lockfile && node --experimental-strip-types bundle.ts)
for bundle in pi-mcp-adapter pi-web-access pi-vetter; do
  install_package "$HOME/.local/share/pi/bundles/$bundle"
done
for ext in background footer goal handoff loop sandbox subagents; do
  install_package "$REPO/$ext"
done

json_merge "$PI_DIR/web-search.json" '.workflow = "none" | .autoOpenBrowser = false'

json_merge "$AGENT_DIR/extensions/permissions.json" \
  '.allow = (((.allow // []) + ["web_search","fetch_content","get_search_content","source_check"]) | unique)'

cp "$REPO/bootstrap/researcher.md" "$AGENT_DIR/agents/researcher.md"

AGENTS_MD="$AGENT_DIR/AGENTS.md"
AGENTS_LINE='Web search and page fetches go through the `researcher` subagent; never call the web tools directly.'
if [ ! -f "$AGENTS_MD" ] || ! grep -Fqx "$AGENTS_LINE" "$AGENTS_MD"; then
  if [ -s "$AGENTS_MD" ] && [ -n "$(tail -c 1 "$AGENTS_MD")" ]; then printf '\n' >>"$AGENTS_MD"; fi
  printf '%s\n' "$AGENTS_LINE" >>"$AGENTS_MD"
fi

echo "bootstrap: done. Next: codass deploy pi"
