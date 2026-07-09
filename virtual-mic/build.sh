#!/usr/bin/env bash
# Build the Parley Microphone virtual audio driver into build/ParleyMicrophone.driver.
#
#   ./build.sh                         # unsigned build (dev)
#   CODESIGN_ID="Developer ID Application: … (TEAMID)" ./build.sh   # signed
#   LIBASPL_SRC=/path/to/libASPL ./build.sh   # build offline against a local checkout
set -euo pipefail

cd "$(dirname "$0")"

CMAKE_ARGS=(-S . -B build -DCMAKE_BUILD_TYPE=Release)
[ -n "${CODESIGN_ID:-}" ] && CMAKE_ARGS+=("-DCODESIGN_ID=${CODESIGN_ID}")
# Universal build for a shipped driver, e.g. ARCHS="arm64;x86_64".
[ -n "${ARCHS:-}" ] && CMAKE_ARGS+=("-DCMAKE_OSX_ARCHITECTURES=${ARCHS}")
# Offline / pinned local libASPL checkout (skips the git fetch).
[ -n "${LIBASPL_SRC:-}" ] && CMAKE_ARGS+=("-DFETCHCONTENT_SOURCE_DIR_LIBASPL=${LIBASPL_SRC}")

cmake "${CMAKE_ARGS[@]}"
cmake --build build --config Release -j

echo ""
echo "Built: $(pwd)/build/ParleyMicrophone.driver"
echo "Install for local testing with: ./install-dev.sh"
