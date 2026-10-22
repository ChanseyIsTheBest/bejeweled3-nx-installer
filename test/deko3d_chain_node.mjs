// Node run of the browser's deko3d shader chain up to SPIRV-Cross: wasm/renut_hlsl (Renut's translator) ->
// wasm/dxc_web (DXC v2025.1, the native renderer's fixed arguments; Renut's -D defines as #define lines) ->
// wasm/spirv_cross (tools/deko3d_shaders.py's arguments). Writes <name>.hlsl, .spv and .vk.glsl into the output folder
// for the comparison with the native chain (peggle2-nx's out/deko3d_shaders/vk).
//   node test/deko3d_chain_node.mjs <containers folder> <output folder> [shader_common.h]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = (n) => pathToFileURL(path.join(here, '..', 'wasm', n)).href;
const [inDir, outDir, commonArg] = process.argv.slice(2);
const common = commonArg || path.join(here, '..', '..', 'peggle1-nx', 'app', 'thirdparty', 'reblue-XenosRecomp',
                                      'XenosRecomp', 'shader_common.h');
fs.mkdirSync(outDir, { recursive: true });
const quiet = () => ({ print: () => {}, printErr: (s) => console.log("  " + s) });

const hlsl = await (await import(wasm('renut_hlsl.mjs'))).default(quiet());
hlsl.FS.mkdir('/in');
for (const f of fs.readdirSync(inDir).filter((n) => n.endsWith('.bin'))) {
  hlsl.FS.writeFile('/in/' + f, fs.readFileSync(path.join(inDir, f)));
}
hlsl.FS.writeFile('/shader_common.h', fs.readFileSync(common));
console.log('renut_hlsl exit', hlsl.callMain(['/in', '/out', '/shader_common.h']));

const dxc = await (await import(wasm('dxc_web.mjs'))).default(quiet());
dxc.FS.mkdirTree('/work');
const cross = await (await import(wasm('spirv_cross.mjs'))).default(quiet());
cross.FS.mkdirTree('/work');
// Renut compiles with -DBANJO_DEKO3D -DRENUT_RECOMP (reblue-XenosRecomp/XenosRecomp/dxc_compiler.cpp).
const PREAMBLE = '#define BANJO_DEKO3D 1\n#define RENUT_RECOMP 1\n';
for (const name of hlsl.FS.readdir('/out').filter((n) => n.endsWith('.hlsl'))) {
  const stem = name.slice(0, -5);
  const text = hlsl.FS.readFile('/out/' + name, { encoding: 'utf8' });
  fs.writeFileSync(path.join(outDir, name), text);
  dxc.FS.writeFile(`/work/${stem}.hlsl`, PREAMBLE + text);
  const rc = dxc.ccall('compile', 'number', ['string', 'string', 'number'],
                       [`/work/${stem}.hlsl`, `/work/${stem}.spv`, stem.startsWith('vs_') ? 1 : 0]);
  if (rc !== 0) { console.log(`${stem}: DXC ${rc}`); continue; }
  const spv = dxc.FS.readFile(`/work/${stem}.spv`);
  fs.writeFileSync(path.join(outDir, stem + '.spv'), spv);
  cross.FS.writeFile(`/work/${stem}.spv`, spv);
  const xr = cross.callMain([`/work/${stem}.spv`, '--version', '460', '--vulkan-semantics', '--relax-nan-checks',
                             '--output', `/work/${stem}.vk.glsl`]);
  const vk = cross.FS.readFile(`/work/${stem}.vk.glsl`, { encoding: 'utf8' });
  fs.writeFileSync(path.join(outDir, stem + '.vk.glsl'), vk);
  console.log(`${stem}: ${spv.length} bytes of SPIR-V, spirv-cross exit ${xr}, ${vk.length} bytes of GLSL`);
}
