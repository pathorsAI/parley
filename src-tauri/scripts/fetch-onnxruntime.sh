#!/usr/bin/env bash
# Fetch the ONNX Runtime shared library used by the audio speaker-diarization
# feature. It is loaded at runtime via ORT_DYLIB_PATH (ort `load-dynamic`), so it
# is NOT linked at build time. The library is intentionally not committed to git —
# run this once for local `tauri dev`, and in CI before `tauri build` so it gets
# bundled (and, on macOS, codesigned) into the app.
#
# Per-platform bundle wiring:
#   macOS   tauri.macos.conf.json   -> onnxruntime/libonnxruntime.dylib (universal2)
#   Windows tauri.windows.conf.json -> onnxruntime/onnxruntime.dll (x64, run via Git Bash)
set -euo pipefail

VERSION="1.22.0" # last ONNX Runtime release shipping a universal2 (x86_64+arm64) macOS dylib
DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/onnxruntime"
mkdir -p "$DEST_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)" in
Darwin)
  DEST="$DEST_DIR/libonnxruntime.dylib"
  if [[ -f "$DEST" ]] && lipo -archs "$DEST" 2>/dev/null | grep -q "x86_64" && lipo -archs "$DEST" 2>/dev/null | grep -q "arm64"; then
    echo "universal2 onnxruntime dylib already present: $DEST"
    exit 0
  fi
  URL="https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}/onnxruntime-osx-universal2-${VERSION}.tgz"
  echo "Downloading $URL"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/ort.tgz" "$URL"
  tar xzf "$TMP/ort.tgz" -C "$TMP"
  cp "$TMP/onnxruntime-osx-universal2-${VERSION}/lib/libonnxruntime.${VERSION}.dylib" "$DEST"
  chmod +w "$DEST"
  echo "Installed universal2 dylib → $DEST"
  lipo -archs "$DEST"
  ;;
MINGW* | MSYS* | CYGWIN*)
  DEST="$DEST_DIR/onnxruntime.dll"
  # Idempotence: a real DLL is ~10s of MB; a placeholder or partial download is not.
  if [[ -f "$DEST" ]] && [[ "$(wc -c <"$DEST")" -gt 1000000 ]]; then
    echo "onnxruntime dll already present: $DEST"
    exit 0
  fi
  URL="https://github.com/microsoft/onnxruntime/releases/download/v${VERSION}/onnxruntime-win-x64-${VERSION}.zip"
  echo "Downloading $URL"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/ort.zip" "$URL"
  unzip -q "$TMP/ort.zip" -d "$TMP"
  cp "$TMP/onnxruntime-win-x64-${VERSION}/lib/onnxruntime.dll" "$DEST"
  # Companion DLL onnxruntime.dll dlopens when execution providers are probed.
  cp "$TMP/onnxruntime-win-x64-${VERSION}/lib/onnxruntime_providers_shared.dll" "$DEST_DIR/" 2>/dev/null || true
  echo "Installed x64 dll → $DEST"
  ;;
*)
  echo "unsupported platform: $(uname -s)" >&2
  exit 1
  ;;
esac
