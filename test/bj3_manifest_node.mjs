// Writes the build's entry of release/manifest.json from the tested files: the player's game (its package or the folder
// it was extracted into), the NRO in release/ and the shaders the page makes (lib/deko3d.js, all of the containers
// default.xex stores). From test/p1_manifest_node.mjs (peggle1-nx-installer) without the title update and DLC.
// Usage: node test/bj3_manifest_node.mjs <game package or folder> <version> [--write]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chosenOnDisk, loadModules, root } from './node_files.mjs';
import { findGames, gameImage } from '../lib/installer.js';
import { imageContainers } from '../lib/containers.js';
import { buildDeko3dPackage } from '../lib/deko3d.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const [input, version] = args.filter((a) => a !== '--write');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const chosen = await findGames(chosenOnDisk([input]));
if (!chosen.game) {
  throw new Error(`no Bejeweled 3 game in ${input}`);
}
const modules = await loadModules();
const { image, xexHash } = await gameImage(chosen, modules);
const unique = [];
for (const c of imageContainers(image)) {
  if (!unique.some((u) => sha(u.bytes) === sha(c.bytes))) unique.push(c);
}
const common = fs.readFileSync(path.join(root, 'renut_shader_common.h'));
const { package: pkg, shaders } = await buildDeko3dPackage(unique, modules, common);
const nro = fs.readFileSync(path.join(root, 'release', 'bejeweled3.nro'));
const build = {
  edition: 'Xbox Live Arcade (title 584111D6)',
  version,
  xex_sha256: xexHash,
  game_files: chosen.game.files.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  nro: 'bejeweled3.nro',
  nro_sha256: sha(nro),
  nro_size: nro.length,
  deko3d: {
    shaders: shaders.map((s) => s.name),
    containers_sha256: shaders.map((s) => sha(unique[s.container].bytes)),
    package_sha256: sha(pkg),
    package_size: pkg.length,
  },
};
const manifest = { version: 1, builds: [build] };
const text = `${JSON.stringify(manifest, null, 2)}\n`;
if (write) {
  fs.writeFileSync(path.join(root, 'release', 'manifest.json'), text);
  console.log(`wrote release/manifest.json (${build.game_files.length} game files, ${shaders.length} shaders, ` +
    `NRO ${build.nro_sha256})`);
} else {
  process.stdout.write(text);
}
