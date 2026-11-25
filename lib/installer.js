// Builds the bejeweled3-nx.zip package from the player's own copy of Bejeweled 3 (Xbox Live Arcade, title 584111D6):
// the game's content package (read in place) or a folder it was extracted into. Bejeweled 3 has no title update and no
// add-on.
//
// The zip holds the Switch build (bejeweled3.nro) and its licenses, the shaders of its renderer made from the game's
// executable (deko3d_glsl.bin: the 71 shaders default.xex stores; the 18 the game compiles while it runs are built into
// the NRO) and the game's files as the asset pack the console mounts (game_root.nxpack + .nxidx). The settings file,
// bejeweled3.toml, is written by the game at its first start, so an update never replaces the player's settings.
//
// From peggle1-nx-installer (2026-10-22): the same steps without Peggle's title update and DLC.

import { readXexImage } from './xex.js';
import { StfsPackage, readStfsHeader } from './from_sa2/stfs_package.js';
import { imageContainers } from './containers.js';
import { buildDeko3dPackage } from './deko3d.js';
import { dataChecksum as packDataChecksum, packChunks, packIndex, planPack } from './nxpack.js';
import { prepareFiles } from './media.js';
import { ZipWriter, zipSize } from './zip.js';
import { formatSize, t } from './i18n.js';

const CHUNK = 16 * 1024 * 1024;
const ROOT = 'bejeweled3-nx';
const NRO = 'bejeweled3.nro';
const TITLE_ID = 0x584111d6;
const CONTENT_GAME = 0x000d0000;
// files whose header is read to find the packages among the chosen files
const MAX_CANDIDATES = 256;

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function* chunksOf(file) {
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    yield await file.read(offset, Math.min(CHUNK, file.size - offset));
  }
}

function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function folderOf(path) {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

// The LZX step of readXexImage, done by libmspack compiled to WebAssembly.
export function lzxStep(lzx) {
  return async (compressed, bits, size) => {
    lzx.FS.writeFile('/image.lzx', compressed);
    const rc = lzx.callMain(['/image.lzx', '/image.bin', String(bits), String(size)]);
    if (rc) {
      throw new Error(`LZX decompression failed (${rc})`);
    }
    const out = lzx.FS.readFile('/image.bin');
    lzx.FS.unlink('/image.lzx');
    lzx.FS.unlink('/image.bin');
    return out;
  };
}

// Where a release file is downloaded from. Its SHA-256 is part of the address, so every version is a different
// address and a copy kept by the browser is never mistaken for a newer one.
export function releasePath(name, hash) {
  return `./release/${name}?sha256=${hash}`;
}

export function programPath(build) {
  return releasePath(build.nro, build.nro_sha256);
}

// Sorts out what the player chose (files [{ path, size, read }] from the "Files" button or every file under the
// "Folder"). Returns { game, others }:
//   game = { kind: 'package' | 'folder', name, files } (the game's files, paths relative to the game) or null;
//   others = names of packages of other games.
export async function findGames(chosen) {
  let game = null;
  const others = [];
  // An extracted game: the shallowest default.xex with main.rsb beside it.
  const byFolder = new Map();
  for (const f of chosen) {
    const folder = folderOf(f.path);
    if (!byFolder.has(folder)) {
      byFolder.set(folder, []);
    }
    byFolder.get(folder).push(f);
  }
  const folders = [...byFolder.keys()].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const folder of folders) {
    const here = byFolder.get(folder);
    const has = (name) => here.find((f) => baseName(f.path).toLowerCase() === name);
    if (!game && has('default.xex') && has('main.rsb')) {
      const files = chosen.filter((f) => f.path.startsWith(folder))
        .map((f) => ({ ...f, path: f.path.slice(folder.length) }))
        .filter((f) => !/(^|\/)(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(f.path) && !f.path.includes('/'));
      game = { kind: 'folder', name: folder ? baseName(folder.slice(0, -1)) : '', files };
    }
  }
  // Packages, by their header (Xbox 360 content packages have no extension; the game's own file types are left out).
  const inside = (f) => game && game.kind === 'folder' && game.files.some((h) => h.read === f.read);
  const candidates = chosen.filter((f) => f.size >= 0xa000 && !inside(f)
    && !/\.(rsb|png|xml|wmv|xex|bin|zip|nro|toml|txt|db|ini)$/i.test(f.path)).slice(0, MAX_CANDIDATES);
  for (const file of candidates) {
    const header = readStfsHeader(await file.read(0, 0x600));
    if (!header) {
      continue;
    }
    const name = baseName(file.path);
    if (header.titleId !== TITLE_ID) {
      others.push(header.displayName || name);
    } else if (header.contentType === CONTENT_GAME && !game) {
      const pkg = await StfsPackage.open(file);
      game = { kind: 'package', name, files: pkg.files().filter((f) => !f.path.includes('/')) };
    }
  }
  return { game, others };
}

function fileNamed(files, name) {
  return files.find((f) => f.path.toLowerCase() === name);
}

// Identifies the build: default.xex by its SHA-256, the game's other files by their sizes. Returns
// { xex, xexHash, build, problems }.
export async function identifyGames(chosen, manifest) {
  const { game } = chosen;
  if (!game) {
    const error = new Error(t('noGame'));
    error.code = 'noGame';
    throw error;
  }
  const xexFile = fileNamed(game.files, 'default.xex');
  const xex = await xexFile.read(0, xexFile.size);
  const xexHash = await sha256(xex);
  const build = manifest.builds.find((b) => b.xex_sha256 === xexHash) || null;
  const problems = [];
  if (build) {
    for (const want of build.game_files) {
      const f = fileNamed(game.files, want.path.toLowerCase());
      if (!f || f.size !== want.size) {
        problems.push('gameDifferent');
        break;
      }
    }
  }
  return { xex, xexHash, build, problems };
}

// The executable the console runs: default.xex's image (Bejeweled 3 has no title update).
export async function gameImage(chosen, modules) {
  const xexFile = fileNamed(chosen.game.files, 'default.xex');
  const xex = await xexFile.read(0, xexFile.size);
  const { image } = await readXexImage(xex, lzxStep(modules.lzx));
  return { image, xexHash: await sha256(xex) };
}

// The shaders of the Switch build's renderer (Renut on deko3d): deko3d_glsl.bin, which the NRO reads beside itself,
// made from the shaders stored in the executable (lib/deko3d.js) and checked against the build's manifest entry
// ("deko3d": { shaders, containers_sha256, package_sha256 }).
// modules: { lzx, renutHlsl, dxc, spirvCross }; renutCommon: Renut's shader_common.h; onShader(done, total) after each.
export async function makeDeko3dPackage(chosen, build, modules, renutCommon, log = () => {}, onShader = () => {}) {
  const { image } = await gameImage(chosen, modules);
  const wanted = build.deko3d.containers_sha256;
  const containers = [];
  const seen = new Set();
  for (const c of imageContainers(image)) {
    const hash = await sha256(c.bytes);
    if (wanted.includes(hash) && !seen.has(hash)) {
      seen.add(hash);
      containers.push(c);
    }
  }
  if (seen.size !== wanted.length) {
    throw new Error(t('deko3dContainers', { found: seen.size, wanted: wanted.length }));
  }
  log(t('deko3dShaders', { count: build.deko3d.shaders.length }));
  let done = 0;
  const { package: pkg } = await buildDeko3dPackage(containers, modules, renutCommon,
    () => onShader(++done, build.deko3d.shaders.length), build.deko3d.shaders);
  const hash = await sha256(pkg);
  if (hash !== build.deko3d.package_sha256) {
    throw new Error(t('deko3dMismatch', { hash }));
  }
  log(t('deko3dReady'));
  return pkg;
}

// chosen: findGames(); release: { manifest, nro, licenses, renutShaderCommon } (bytes)
// modules: { lzx, renutHlsl, dxc, spirvCross } instantiated Emscripten modules
// sink: { write(Uint8Array), close() } receiving the zip file
// onSize(bytes) is called with the exact size of the zip before the first byte is written.
// update: only the program, its licenses and the shaders, for a folder already on the SD card.
export async function createPackage(chosen, release, modules, sink, log = () => {}, progress = () => {},
  onSize = () => {}, { update = false, compress = null, audio = null, video = null } = {}) {
  const id = await identifyGames(chosen, release.manifest);
  const { build } = id;
  if (!build) {
    throw new Error(t('notSupportedYet', { hash: id.xexHash }));
  }
  if (id.problems.length) {
    throw new Error(t(id.problems[0]));
  }
  log(t('logBuild', { version: build.version }));
  if (update) {
    log(t('logUpdate'));
  }

  // The shaders first: they are the step most likely to stop the package, and nothing is written before them.
  const stage = (from, to) => (f) => progress(from + (to - from) * Math.min(Math.max(f, 0), 1));
  const shaderStage = stage(0, update ? 0.9 : 0.35);
  const deko3d = await makeDeko3dPackage(chosen, build, modules, release.renutShaderCommon, log,
    (done, total) => shaderStage(done / total));

  let gameIndex = null;
  let plan = null;
  let dataChecksum = 0n;
  if (!update) {
    // The game pack: the game's files as the console mounts them.
    // The PopCap ports (2026-11-24, sa2-nx-ult-installer's way): every game file but the module as LZ4 / ZXC blocks
    // (lib/media.js), each stand-in made once, with the size the game sees; the pack is the port's version 3
    // (lib/nxpack.js), whose index gives the console those sizes.
    if (!compress) {
      throw new Error('no compressor for the game files');
    }
    const gameFiles = chosen.game.files;
    log(t('packingFiles', { count: gameFiles.length }));
    const middle = 0.35 + (0.55 - 0.35) * 0.8;
    const prepared = await prepareFiles(gameFiles, compress, { audio, video, log, onProgress: stage(0.35, middle) });
    log(t('packedSizes', { before: formatSize(prepared.before), after: formatSize(prepared.after) }));
    plan = planPack(prepared.files);
    log(t('checksumming', { count: plan.items.length }));
    const sum = stage(middle, 0.55);
    let seen = 0;
    dataChecksum = await packDataChecksum(plan, (item) => item.file.chunks(), (chunk) => {
      seen += chunk.length;
      sum(seen / plan.packSize);
    });
    gameIndex = packIndex(plan, dataChecksum);
  }

  const entries = [
    { path: `${ROOT}/${NRO}`, size: release.nro.length },
    { path: `${ROOT}/LICENSES.txt`, size: release.licenses.length },
    { path: `${ROOT}/deko3d_glsl.bin`, size: deko3d.length },
    ...(update ? [] : [
      { path: `${ROOT}/game_root.nxidx`, size: gameIndex.length },
      { path: `${ROOT}/game_root.nxpack`, size: plan.packSize },
    ]),
  ];
  onSize(zipSize(entries));
  log(t('packing'));
  const total = update ? 1 : plan.packSize;
  const write = stage(update ? 0.9 : 0.55, 1);
  let done = 0;
  const onChunk = (chunk) => {
    done += chunk.length;
    write(done / total);
  };
  const zip = new ZipWriter(sink);
  await zip.addBytes(`${ROOT}/${NRO}`, release.nro);
  await zip.addBytes(`${ROOT}/LICENSES.txt`, release.licenses);
  await zip.addBytes(`${ROOT}/deko3d_glsl.bin`, deko3d);
  if (!update) {
    await zip.addBytes(`${ROOT}/game_root.nxidx`, gameIndex);
    await zip.addFile(`${ROOT}/game_root.nxpack`, plan.packSize,
      packChunks(plan, dataChecksum, (item) => item.file.chunks()), onChunk);
  }
  await zip.finish();
  progress(1);
  log(t('done'));
  return { version: build.version, update };
}
