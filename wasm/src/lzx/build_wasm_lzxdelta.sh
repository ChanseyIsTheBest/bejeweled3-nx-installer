#!/bin/bash
# Builds wasm/lzxdelta.mjs + .wasm: the LZX delta decoder of XEX patches (wasm/src/lzx/peggle1_lzxdelta.cpp with the
# unmodified libmspack lzxd.c and system.c of peggle1-nx's sdk/thirdparty/libmspack), with the options futari-nx's
# shaders/wasm/build_wasm_tools.sh builds wasm/lzx.* with (Emscripten 6.0.11).
#
#   PEGGLE1_NX  the peggle1-nx checkout           (default: ../peggle1-nx next to the installer)
#   EMSDK       an emsdk folder (used when em++ is not on PATH; default: D:/sonic adventure 2/_tools/emsdk)
#   OUT         output folder                       (default: the installer's wasm/)
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$(cd "$HERE/../../.." && pwd)"
PEGGLE1_NX="${PEGGLE1_NX:-$INSTALLER/../peggle1-nx}"
OUT="${OUT:-$INSTALLER/wasm}"
if ! command -v em++ >/dev/null; then
  EMSDK="${EMSDK:-D:/sonic adventure 2/_tools/emsdk}"
  # shellcheck disable=SC1091
  source "$EMSDK/emsdk_env.sh" >/dev/null
fi
MSPACK="$PEGGLE1_NX/sdk/thirdparty/libmspack/libmspack/mspack"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
COMMON=(-sEXPORT_ES6=1 -sMODULARIZE=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=4MB -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node)
emcc -O2 -I"$MSPACK" -c "$MSPACK/lzxd.c" -o "$TMP/lzxd.o"
emcc -O2 -I"$MSPACK" -c "$MSPACK/system.c" -o "$TMP/system.o"
em++ -std=c++20 -O2 -I"$MSPACK" "$HERE/peggle1_lzxdelta.cpp" "$TMP/lzxd.o" "$TMP/system.o" -o "$OUT/lzxdelta.mjs" \
  -sEXPORT_NAME=createLzxDeltaModule "${COMMON[@]}"
echo "wrote $OUT/lzxdelta.mjs and lzxdelta.wasm"
