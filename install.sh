#!/bin/bash
#
# Installs the CEP extension for development by:
#   1. Enabling unsigned extensions (PlayerDebugMode)
#   2. Symlinking this folder into the CEP extensions directory
#
# Usage:  ./install.sh
# Then restart Illustrator and open: Window > Extensions > Offset Panel

set -e

EXT_ID="com.example.offsetpanel"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# macOS CEP extensions folder
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"

echo "=== Offset Panel — CEP Extension Installer ==="
echo ""

# 1. Enable unsigned extensions
echo "Setting PlayerDebugMode=1 for CSXS.9 through CSXS.12 ..."
for v in 9 10 11 12; do
    defaults write com.adobe.CSXS.${v} PlayerDebugMode 1 2>/dev/null || true
done
echo "Done."
echo ""

# 2. Create symlink
mkdir -p "$DEST_DIR"
if [ -L "$DEST_DIR/$EXT_ID" ]; then
    echo "Removing existing symlink ..."
    rm "$DEST_DIR/$EXT_ID"
fi
if [ -d "$DEST_DIR/$EXT_ID" ]; then
    echo "WARNING: A real directory already exists at $DEST_DIR/$EXT_ID"
    echo "         Remove it manually if you want to use the symlink."
    exit 1
fi

ln -s "$SRC_DIR" "$DEST_DIR/$EXT_ID"
echo "Symlinked:"
echo "  $SRC_DIR"
echo "  -> $DEST_DIR/$EXT_ID"
echo ""
echo "Restart Illustrator, then open: Window > Extensions > Offset Panel"
