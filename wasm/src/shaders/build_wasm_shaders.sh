#!/usr/bin/env bash
# Builds the installer's shader translator and library packer (wasm/hlsl.* and wasm/pack.*) from the peggle2-nx
# repository, with the same sources and options as tools/build_shader_library.sh of peggle2-nx uses natively:
#   hlsl.mjs  the container -> HLSL translator: shaders/tools/masseffect_hlsl.cpp + shaders/XenosRecomp, with
#             MASSEFFECT_RECOMP (the translator of the tested library; its HLSL header is shader_common.h, which the
#             page passes in: keep the installer's copy equal to peggle2-nx's shaders/XenosRecomp/shader_common.h)
#   pack.mjs  the package + index packer: shaders/tools/me_pack_shaders.cpp + app/src/me/masseffect/
#             masseffect_shader_library.cpp (the library format the NRO reads)
# The compile options are futari-nx's shaders/wasm/build_wasm_tools.sh (Emscripten 6.0.11): -O1 for the translator,
# -O2 for the packer. peggle2-nx's own copy of that script points the packer at app/src/native/masseffect, which does
# not exist in this port (the library code is in app/src/me/masseffect, as build_shader_library.sh has it).
# wasm/dxc_web.* (DXC v2025.1, nfsmw-nx-installer's build) and wasm/lzx.* (libmspack's LZX decoder) are not
# game-specific and are not rebuilt here.
#
#   PEGGLE2_NX  the peggle2-nx checkout              (default: ../peggle2-nx next to the installer)
#   EMSDK       an emsdk folder with Emscripten 6.0.11 (used when em++ is not on PATH;
#               default: D:/sonic adventure 2/_tools/emsdk)
#   OUT         output folder                         (default: the installer's wasm/)
#   usage: wasm/src/shaders/build_wasm_shaders.sh [hlsl] [pack]     (default: both)
#
# Both modules are the command line programs: the page writes the inputs into Emscripten's in-memory file system and
# calls callMain([...]) with the same arguments as on the command line, then reads the outputs back.
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALLER=$(cd "$HERE/../../.." && pwd)
PEGGLE2_NX=${PEGGLE2_NX:-$INSTALLER/../peggle2-nx}
PEGGLE2_NX=$(cd "$PEGGLE2_NX" && pwd)
OUT=${OUT:-$INSTALLER/wasm}
mkdir -p "$OUT"

if ! command -v em++ >/dev/null 2>&1; then
  EMSDK=${EMSDK:-"D:/sonic adventure 2/_tools/emsdk"}
  command -v cygpath >/dev/null 2>&1 && EMSDK=$(cygpath -u "$EMSDK")  # Git Bash: PATH entries must be POSIX paths
  [ -f "$EMSDK/.emscripten" ] || { echo "em++ not found and no emsdk at $EMSDK: set EMSDK" >&2; exit 1; }
  export EM_CONFIG="$EMSDK/.emscripten"
  for d in "$EMSDK"/python/*/ "$EMSDK"/node/*/; do PATH="$d:$PATH"; done
  PATH="$EMSDK/upstream/emscripten:$PATH"
  export PATH
fi
echo "em++: $(em++ --version | head -1)"

SHADERS=$PEGGLE2_NX/shaders
XENOS=$SHADERS/XenosRecomp
APP=$PEGGLE2_NX/app/src/me/masseffect
XXHASH_DIR=${XXHASH_DIR:-$PEGGLE2_NX/sdk/thirdparty/xxHash}
FMT_DIR=${FMT_DIR:-$PEGGLE2_NX/sdk/thirdparty/fmt/include}
for f in "$SHADERS/tools/masseffect_hlsl.cpp" "$XENOS/shader_recompiler.cpp" "$SHADERS/tools/me_pack_shaders.cpp" \
         "$APP/masseffect_shader_library.cpp" "$XXHASH_DIR/xxhash.h" "$FMT_DIR/fmt/format.h"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done
if ! cmp -s "$XENOS/shader_common.h" "$INSTALLER/shader_common.h"; then
  echo "note: $INSTALLER/shader_common.h differs from $XENOS/shader_common.h (the page passes the installer's copy)"
fi

COMMON=(-sEXPORT_ES6=1 -sMODULARIZE=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=4MB -sEXPORTED_RUNTIME_METHODS=FS,callMain -sENVIRONMENT=web,worker,node)
targets=${*:-hlsl pack}

for t in $targets; do
  echo "=== $t"
  case $t in
    hlsl)
      em++ -std=c++20 -O1 -I"$SHADERS" -I"$XENOS" -I"$FMT_DIR" -I"$XXHASH_DIR" -include "$XENOS/pch_min.h" \
        -Wno-null-arithmetic -fms-extensions -DFMT_HEADER_ONLY -DXXH_INLINE_ALL -DMASSEFFECT_RECOMP \
        "$SHADERS/tools/masseffect_hlsl.cpp" "$XENOS/shader_recompiler.cpp" -o "$OUT/hlsl.mjs" \
        -sEXPORT_NAME=createHlslModule "${COMMON[@]}";;
    pack)
      # The packer holds the whole library in memory; 4 GB is the address space of wasm32 (Peggle 2's is small).
      em++ -std=c++20 -O2 -I"$XXHASH_DIR" "$SHADERS/tools/me_pack_shaders.cpp" "$APP/masseffect_shader_library.cpp" \
        -o "$OUT/pack.mjs" -sEXPORT_NAME=createPackModule -sMAXIMUM_MEMORY=4GB "${COMMON[@]}";;
    *) echo "unknown target $t" >&2; exit 1;;
  esac
done
echo "done: $OUT"
