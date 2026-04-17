#!/bin/bash
set -e

# Build ohp binary from source
# Usage: ./scripts/build-binary.sh [--install] [--prefix DIR]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PREFIX="$HOME/.local"
INSTALL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --install|-i)
            INSTALL=true
            shift
            ;;
        --prefix)
            shift
            PREFIX="$1"
            shift
            ;;
        --prefix=*)
            PREFIX="${1#*=}"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --install, -i     Install binary after building"
            echo "  --prefix DIR      Install prefix (default: ~/.local)"
            echo "                    Binary goes to DIR/bin/ohp"
            echo "  --help, -h        Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

cd "$REPO_ROOT"

echo "==> Installing dependencies..."
bun install

echo "==> Typechecking..."
bun check:ts


echo "==> Regenerating models.json (dynamic provider catalogs)..."
bun --cwd=packages/ai scripts/generate-models.ts

echo "==> Building ohp binary..."
bun --cwd=packages/coding-agent run build:binary

BINARY="$REPO_ROOT/packages/coding-agent/dist/ohp"

if [[ ! -f "$BINARY" ]]; then
    echo "Build failed: $BINARY not found"
    exit 1
fi

echo "==> Built: $BINARY"
ls -lh "$BINARY"

if $INSTALL; then
    DEST="$PREFIX/bin/ohp"
    mkdir -p "$PREFIX/bin"
    cp "$BINARY" "$DEST"
    chmod +x "$DEST"
    echo "==> Installed: $DEST"
    "$DEST" --version
fi
