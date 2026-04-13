#!/usr/bin/env bash
#
# agent-middleware · one-line installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/miles990/agent-middleware/main/install.sh | bash
#
# Or from a local checkout:
#   bash install.sh
#
# Cross-platform: macOS / Linux / WSL. For native Windows, use WSL.
#
set -euo pipefail

INSTALL_DIR="${AGENT_MIDDLEWARE_DIR:-$HOME/.agent-middleware}"
REPO_URL="${AGENT_MIDDLEWARE_REPO:-https://github.com/miles990/agent-middleware.git}"

# Use existing checkout if we're already inside one
if [ -f "package.json" ] && grep -q '"agent-middleware"' package.json 2>/dev/null; then
  INSTALL_DIR="$(pwd)"
  echo "▶ Using existing checkout at: $INSTALL_DIR"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "▶ Updating $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    echo "▶ Cloning to $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi

# Ensure Node.js is available
if ! command -v node >/dev/null 2>&1; then
  echo "❌ node.js not found. Install Node.js 20+ first:"
  echo "   macOS:   brew install node"
  echo "   Linux:   curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts"
  echo "   Windows: use WSL or https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js 20+ required (found v$(node -p "process.versions.node"))"
  exit 1
fi

# Ensure pnpm is available
if ! command -v pnpm >/dev/null 2>&1; then
  echo "▶ Installing pnpm globally"
  npm install -g pnpm
fi

# Install dependencies (needed before running the wizard, since wizard imports @clack/prompts)
echo "▶ Installing dependencies"
pnpm install --silent

# Launch the interactive setup wizard — it handles pm2, .env, build, start, health check
echo "▶ Launching setup wizard"
pnpm run setup
