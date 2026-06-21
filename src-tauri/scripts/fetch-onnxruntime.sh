#!/usr/bin/env bash
# Fetch the ONNX Runtime universal2 dylib used by the audio speaker-diarization
# feature. It is loaded at runtime via ORT_DYLIB_PATH (ort `load-dynamic`), so it
# is NOT linked at build time. The dylib (~67 MB universal2) is intentionally not
# committed to git — run this once for local `tauri dev`, and in CI before
# `tauri build` so it gets bundled (and codesigned) into the .app.
#
# tauri.conf.json bundles it via bundle.resources -> onnxruntime/libonnxruntime.dylib
set -euo pipefail

VERSION="1.22.0" # last ONNX Runtime release shipping a universal2 (x86_64+arm64) macOS dylib
DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/onnxruntime"
DEST="$DEST_DIR/libonnxruntime.dylib"

mkdir -p "$DEST_DIR"
if [ -f "$DEST" ] && lipo -archs "$DEST" 2>/dev/null | grep -q "x86_64" && lipo -archs "$DEST" 2>/dev/null | grep -q "arm64"; then
  echo "universal2 onnxruntime dylib already present: $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}/onnxruntime-osx-universal2-${VERSION}.tgz"
echo "Downloading $URL"
curl -fsSL -o "$TMP/ort.tgz" "$URL"
tar xzf "$TMP/ort.tgz" -C "$TMP"
cp "$TMP/onnxruntime-osx-universal2-${VERSION}/lib/libonnxruntime.${VERSION}.dylib" "$DEST"
chmod +w "$DEST"

echo "Installed universal2 dylib → $DEST"
lipo -archs "$DEST"
