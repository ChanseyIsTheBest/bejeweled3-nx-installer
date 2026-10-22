// The shaders of the Switch build's renderer (Renut on deko3d), made from the player's own default.xex (with the title
// update applied: lib/xexp.js): deko3d_glsl.bin, which the NRO reads beside itself. peggle1-nx's NRO carries none of
// the game's shaders (Peggle 1 has no port shaders: its PopCap logo is a WMV the game decodes on the CPU).
//
// The chain is peggle2-nx's native one (Renut's XenosRecomp with BANJO_DEKO3D_SPIRV_DIR, tools/deko3d_shaders.py,
// tools/deko3d_glsl_opt.py, tools/deko3d_shader_package.py), in the page:
//   wasm/renut_hlsl   Renut's translator (peggle2-nx's tools/renut_hlsl_frontend.cpp): container -> HLSL
//   wasm/dxc_web      DXC v2025.1 with the native renderer's fixed arguments; Renut's -DBANJO_DEKO3D -DRENUT_RECOMP
//                     come first in the text as #define lines, and the y flip it adds to a vertex shader
//                     (-fvk-invert-y; deko3d takes D3D's clip space as it is) is taken out of the GLSL below
//   wasm/spirv_cross  SPIRV-Cross with tools/deko3d_shaders.py's arguments
//   lib/deko3d_glsl   tools/deko3d_glsl.py's conversion and tools/deko3d_glsl_opt.py's passes
//   lib/deko3d_package the package (zstd frames of raw blocks, no dictionary)
// Checked against the native chain (DXC 1.8.2407, ps/vs_6_0; peggle1-nx without early alpha: out/deko3d_release) by
// test/p1_deko3d_node.mjs; the package is pinned by its SHA-256 in the build's manifest entry.

import { deko3dShader } from './deko3d_glsl.js';
import { writeDeko3dPackage } from './deko3d_package.js';

const DXC_PREAMBLE = '#define BANJO_DEKO3D 1\n#define RENUT_RECOMP 1\n';

// DXC's -fvk-invert-y, as SPIRV-Cross writes it: the position copied, its y negated, the copy stored. Back to the
// position stored as it is (what the native chain, compiled without the flag, writes).
export function undoInvertY(glsl) {
  const re = /^([ \t]*)vec4 (_\d+) = (_\d+);\n[ \t]*\2\.y = -\3\.y;\n[ \t]*gl_Position = \2;$/m;
  const m = re.exec(glsl);
  if (!m) {
    throw new Error('deko3d: the vertex shader has no y flip where DXC puts it');
  }
  return glsl.slice(0, m.index) + `${m[1]}gl_Position = ${m[3]};` + glsl.slice(m.index + m[0].length);
}

// containers: [{ stage, bytes }] (the image's stored containers, lib/shaders.js imageContainers()); modules:
// { renutHlsl, dxc, spirvCross } instantiated Emscripten modules (fresh ones: the translator wants an empty output
// folder); shaderCommon: Renut's shader_common.h (peggle2-nx's app/thirdparty/reblue-XenosRecomp/XenosRecomp/).
// names: the shaders to translate, by the translator's names (XXH3 of the container); null: every one it wrote.
// Returns { package, shaders: [{ name, glsl, container }] } (container: the index in `containers` of its source).
export async function buildDeko3dPackage(containers, modules, shaderCommon, log = () => {}, names = null) {
  const { renutHlsl, dxc, spirvCross } = modules;
  renutHlsl.FS.writeFile('/shader_common.h', shaderCommon);
  // One container a run (the translator names its output by the container's XXH3, the shaders' names).
  const sourceOf = new Map();
  containers.forEach((c, i) => {
    renutHlsl.FS.mkdirTree(`/deko3d_in/${i}`);
    renutHlsl.FS.writeFile(`/deko3d_in/${i}/${c.stage}.bin`, c.bytes);
    const rc = renutHlsl.callMain([`/deko3d_in/${i}`, `/deko3d_out/${i}`, '/shader_common.h']);
    if (rc !== 0 && rc !== undefined) {
      throw new Error(`deko3d: the translator failed on container ${i} (${rc})`);
    }
    for (const n of renutHlsl.FS.readdir(`/deko3d_out/${i}`).filter((f) => f.endsWith('.hlsl'))) {
      sourceOf.set(n.slice(0, -5), i);
    }
  });
  const wanted = names || [...sourceOf.keys()].sort();
  const missing = wanted.filter((n) => !sourceOf.has(n));
  if (missing.length) {
    throw new Error(`deko3d: ${missing.join(', ')} not among the translated shaders (${[...sourceOf.keys()].join(', ')})`);
  }
  dxc.FS.mkdirTree('/deko3d');
  spirvCross.FS.mkdirTree('/deko3d');
  const shaders = [];
  for (const name of wanted) {
    const vertex = name.startsWith('vs_');
    const hlsl = renutHlsl.FS.readFile(`/deko3d_out/${sourceOf.get(name)}/${name}.hlsl`, { encoding: 'utf8' });
    dxc.FS.writeFile(`/deko3d/${name}.hlsl`, DXC_PREAMBLE + hlsl);
    const crc = dxc.ccall('compile', 'number', ['string', 'string', 'number'],
                          [`/deko3d/${name}.hlsl`, `/deko3d/${name}.spv`, vertex ? 1 : 0]);
    if (crc !== 0) {
      throw new Error(`deko3d: DXC rejected ${name} (${crc})`);
    }
    spirvCross.FS.writeFile(`/deko3d/${name}.spv`, dxc.FS.readFile(`/deko3d/${name}.spv`));
    const xrc = spirvCross.callMain([`/deko3d/${name}.spv`, '--version', '460', '--vulkan-semantics',
                                     '--relax-nan-checks', '--output', `/deko3d/${name}.vk.glsl`]);
    if (xrc !== 0 && xrc !== undefined) {
      throw new Error(`deko3d: SPIRV-Cross rejected ${name} (${xrc})`);
    }
    let vk = spirvCross.FS.readFile(`/deko3d/${name}.vk.glsl`, { encoding: 'utf8' });
    if (vertex) {
      vk = undoInvertY(vk);
    }
    const glsl = deko3dShader(name, vk).opt;  // tools/deko3d_shaders.py + tools/deko3d_glsl_opt.py
    shaders.push({ name, glsl, container: sourceOf.get(name) });
    log(`deko3d: ${name}`);
  }
  return { package: writeDeko3dPackage(shaders), shaders };
}
