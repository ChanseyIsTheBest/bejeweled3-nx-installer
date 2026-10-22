// Node check of wasm/renut_hlsl.* (Renut's shader translator for the deko3d renderer): translates the containers of a
// folder and compares each HLSL with the native translator's dump of the same container (its first line is a comment
// the native tool adds; the rest must be equal byte for byte).
//   node test/deko3d_hlsl_node.mjs <containers folder> <native dump folder> [shader_common.h]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [inDir, refDir, commonArg] = process.argv.slice(2);
if (!inDir || !refDir) {
  console.log('usage: node test/deko3d_hlsl_node.mjs <containers folder> <native dump folder> [shader_common.h]');
  process.exit(1);
}
const common = commonArg || path.join(here, '..', '..', 'peggle1-nx', 'app', 'thirdparty', 'reblue-XenosRecomp',
                                      'XenosRecomp', 'shader_common.h');
const { default: create } = await import(pathToFileURL(path.join(here, '..', 'wasm', 'renut_hlsl.mjs')).href);
const out = [];
const m = await create({ print: (s) => out.push(s), printErr: (s) => out.push('ERR ' + s) });
m.FS.mkdir('/in');
for (const f of fs.readdirSync(inDir).filter((n) => n.endsWith('.bin'))) {
  m.FS.writeFile('/in/' + f, fs.readFileSync(path.join(inDir, f)));
}
m.FS.writeFile('/shader_common.h', fs.readFileSync(common));
const status = m.callMain(['/in', '/out', '/shader_common.h']);
console.log(out.join('\n'));
console.log('exit', status);
let same = 0, differ = 0;
const refs = fs.readdirSync(refDir).filter((n) => n.endsWith('.hlsl'));
for (const name of m.FS.readdir('/out').filter((n) => n.endsWith('.hlsl'))) {
  const text = m.FS.readFile('/out/' + name, { encoding: 'utf8' });
  const hash = name.slice(3, 19).toLowerCase();
  const ref = refs.find((r) => r.toLowerCase().includes(hash));
  if (!ref) { console.log(`${name}: no native dump`); continue; }
  const refText = fs.readFileSync(path.join(refDir, ref), 'utf8');
  const body = refText.slice(refText.indexOf('\n') + 1);
  if (body === text) { ++same; console.log(`${name}: identical to ${ref}`); }
  else { ++differ; console.log(`${name}: DIFFERENT from ${ref} (${text.length} vs ${body.length} bytes)`); }
}
console.log(`${same} identical, ${differ} different`);
