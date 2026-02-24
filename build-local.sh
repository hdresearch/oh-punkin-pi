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

echo "==> Building punkin for $PLATFORM"

# Generate build info
GIT_COMMIT=$(git rev-parse --short=12 HEAD)
BUILD_TIME=$(TZ=America/New_York date +%Y%m%dT%H%M%S)
BUILD_INFO_FILE="$CODING_AGENT/src/build-info.ts"

echo "==> Generating build-info.ts (commit: $GIT_COMMIT, time: $BUILD_TIME)"
cat > "$BUILD_INFO_FILE" << EOF
/**
 * Build info - generated at build time.
 * DO NOT EDIT - this file is overwritten by build-local.sh
 */

export const BUILD_COMMIT: string = "$GIT_COMMIT";
export const BUILD_TIME: string = "${BUILD_TIME}NYC";
EOF

# Build all packages in dependency order
echo "==> Building packages..."
cd "$REPO_ROOT/packages/tui" && npm run build
cd "$REPO_ROOT/packages/ai" && npm run build
cd "$REPO_ROOT/packages/agent" && npm run build
cd "$REPO_ROOT/packages/coding-agent" && npm run build

# Build binary
echo "==> Building binary..."
cd "$CODING_AGENT"
npm run build:binary

# Create builds dir
mkdir -p "$BUILDS_DIR"

# Copy binary
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
BINARY_NAME="punkin-${PLATFORM}-${TIMESTAMP}"

cp dist/punkin "$BUILDS_DIR/$BINARY_NAME"
chmod +x "$BUILDS_DIR/$BINARY_NAME"

# Also copy as just 'punkin' for convenience
cp dist/punkin "$BUILDS_DIR/punkin"
chmod +x "$BUILDS_DIR/punkin"

# macOS: ad-hoc sign to avoid quarantine/Gatekeeper issues
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "==> Signing binaries (ad-hoc)..."
    codesign -s - "$BUILDS_DIR/$BINARY_NAME"
    codesign -s - "$BUILDS_DIR/punkin"
fi

# Copy supporting assets
cp -r dist/theme "$BUILDS_DIR/" 2>/dev/null || true
cp -r dist/export-html "$BUILDS_DIR/" 2>/dev/null || true
cp -r dist/prompts "$BUILDS_DIR/" 2>/dev/null || true
cp -r dist/docs "$BUILDS_DIR/" 2>/dev/null || true
cp dist/photon_rs_bg.wasm "$BUILDS_DIR/" 2>/dev/null || true
cp package.json "$BUILDS_DIR/" 2>/dev/null || true

echo "==> Built: $BUILDS_DIR/$BINARY_NAME"
echo "==> Binary: $BUILDS_DIR/punkin"
ls -lh "$BUILDS_DIR/punkin"
