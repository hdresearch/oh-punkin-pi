#!/usr/bin/env bash
# Build pi binary and copy to builds/ at repo root
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILDS_DIR="$REPO_ROOT/builds"
CODING_AGENT="$REPO_ROOT/packages/coding-agent"

# Detect platform
case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLATFORM="darwin-arm64" ;;
    Darwin-x86_64) PLATFORM="darwin-x64" ;;
    Linux-aarch64) PLATFORM="linux-arm64" ;;
    Linux-x86_64) PLATFORM="linux-x64" ;;
    *) PLATFORM="unknown" ;;
esac

echo "==> Building pi for $PLATFORM"

# Build
cd "$CODING_AGENT"
npm run build:binary

# Create builds dir
mkdir -p "$BUILDS_DIR"

# Copy binary
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
BINARY_NAME="pi-${PLATFORM}-${TIMESTAMP}"

cp dist/pi "$BUILDS_DIR/$BINARY_NAME"
chmod +x "$BUILDS_DIR/$BINARY_NAME"

# Also copy as just 'pi' for convenience
cp dist/pi "$BUILDS_DIR/pi"
chmod +x "$BUILDS_DIR/pi"

# Copy supporting assets
cp -r dist/theme "$BUILDS_DIR/" 2>/dev/null || true
cp -r dist/export-html "$BUILDS_DIR/" 2>/dev/null || true
cp -r dist/docs "$BUILDS_DIR/" 2>/dev/null || true
cp dist/photon_rs_bg.wasm "$BUILDS_DIR/" 2>/dev/null || true

echo "==> Built: $BUILDS_DIR/$BINARY_NAME"
echo "==> Symlink: $BUILDS_DIR/pi"
ls -lh "$BUILDS_DIR/pi"
