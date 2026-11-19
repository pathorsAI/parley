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
#
# Source: Microsoft's `Microsoft.ML.OnnxRuntime` NuGet package, pinned by the
# SHA-512 nuget.org publishes for it. The GitHub release assets this used to
# download (github.com/microsoft/onnxruntime) stopped resolving on 2026-11-19 and
# broke the v0.37.0 release build. The NuGet package carries the same version's
# native libraries for every platform; macOS ships arm64 and x86_64 separately,
# so the two are joined into the universal2 dylib the bundle expects.
set -euo pipefail

VERSION="1.22.0"
PKG_URL="https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${VERSION}/microsoft.ml.onnxruntime.${VERSION}.nupkg"
PKG_SHA512="zb3eqkL6hHPGzZgArsuTH9VWdUs4ooKTJHBXF6ZZfQsPvzModaAEv3u69zwtqKuwUJ/DPc8i+uKoyXMzdwqrPg=="
DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/onnxruntime"
mkdir -p "$DEST_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Download the package and refuse it unless it matches the pinned hash, then
# unpack only the platform's binaries.
fetch_package() {
  echo "Downloading $PKG_URL"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$TMP/ort.nupkg" "$PKG_URL"
  local got
  got="$(openssl dgst -sha512 -binary "$TMP/ort.nupkg" | openssl base64 -A)"
  if [[ "$got" != "$PKG_SHA512" ]]; then
    echo "Microsoft.ML.OnnxRuntime ${VERSION}: hash mismatch (got $got)" >&2
    exit 1
  fi
  unzip -q -o "$TMP/ort.nupkg" "$@" -d "$TMP"
}

BIN="runtimes"

case "$(uname -s)" in
Darwin)
  DEST="$DEST_DIR/libonnxruntime.dylib"
  if [[ -f "$DEST" ]] && lipo -archs "$DEST" 2>/dev/null | grep -q "x86_64" && lipo -archs "$DEST" 2>/dev/null | grep -q "arm64"; then
    echo "universal2 onnxruntime dylib already present: $DEST"
    exit 0
  fi
  fetch_package "$BIN/osx-arm64/native/libonnxruntime.dylib" "$BIN/osx-x64/native/libonnxruntime.dylib"
  rm -f "$DEST"
  lipo -create \
    "$TMP/$BIN/osx-arm64/native/libonnxruntime.dylib" \
    "$TMP/$BIN/osx-x64/native/libonnxruntime.dylib" \
    -output "$DEST"
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
  fetch_package "$BIN/win-x64/native/onnxruntime.dll" "$BIN/win-x64/native/onnxruntime_providers_shared.dll"
  cp "$TMP/$BIN/win-x64/native/onnxruntime.dll" "$DEST"
  # Companion DLL onnxruntime.dll dlopens when execution providers are probed
  # (bundled by tauri.windows.conf.json).
  cp "$TMP/$BIN/win-x64/native/onnxruntime_providers_shared.dll" "$DEST_DIR/"
  echo "Installed x64 dll → $DEST"
  ;;
*)
  echo "unsupported platform: $(uname -s)" >&2
  exit 1
  ;;
esac
