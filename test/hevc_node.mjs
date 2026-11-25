// The PopCap ports (2026-11-24, the user: "Convert all videos to h265 please"): a game's WMV movie as an H.265 copy on a
// PC, the same file the page makes in the browser (lib/movies.js reencodeMovie, nights-nx-installer's after
// culdcept-nx-installer's), with ffmpeg's libx265 in place of the browser's encoder:
//   1. the ASF file read as its frames (lib/asf.js);
//   2. the pictures the game's decoder shows, frame by frame (lib/movies.js showPictures: wasm/vc1, FFmpeg's WMV3
//      decoder with B pictures in display order: the newest picture given, the first frame's own at the start, nothing
//      for a skipped frame), piped to ffmpeg's libx265 at `fraction` of the movie's own video bitrate (35 %), a keyframe
//      every `gop` pictures, no B frames (one picture out per picture in, in order), an access unit delimiter leading
//      each picture (the port knows the movie by its first bytes), the parameter sets with every keyframe (the base's
//      settings: renut-ultimate's docs/media-compression.md, "On a PC (ffmpeg)");
//   3. the file written again with the H.265 pictures in place of the WMV3 frames (lib/asf.js); skipped frames kept.
// reencodeMovieNode(bytes, vc1, options) -> { bytes, frames, pictures, kbps, why } as reencodeMovie answers.
//
// As a command, a check of one movie (game data: never commit or share what it reads or writes):
//   node test/hevc_node.mjs <movie.wmv> [<out.wmv>]
// re-encodes it, reads the copy back (the same header, the same objects and times, every audio object byte for byte)
// and gives the PSNR of every picture against the picture the game's decoder shows at that frame (ffmpeg decoding the
// H.265 frames).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Asf } from '../lib/asf.js';
import { isSkipped, showPictures } from '../lib/movies.js';

const FFMPEG = process.env.FFMPEG || 'C:/ffmpeg/ffmpeg.exe';

// the NAL units of an Annex B stream: [{ type, start (of its start code), end }]
function nalUnits(b) {
  const starts = [];
  for (let i = 0; i + 3 <= b.length;) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      starts.push({ at: i > 0 && b[i - 1] === 0 ? i - 1 : i, header: i + 3 });
      i += 3;
    } else {
      ++i;
    }
  }
  return starts.map((s, k) => ({ type: (b[s.header] >> 1) & 0x3f, start: s.at,
    end: k + 1 < starts.length ? starts[k + 1].at : b.length }));
}

// the access units: each from its delimiter (type 35) to the next; key when it holds an IDR or CRA picture (19-21)
export function accessUnits(stream) {
  const aus = [];
  for (const u of nalUnits(stream)) {
    if (u.type === 35) aus.push({ start: u.start, end: u.end, key: false });
    else if (aus.length) aus[aus.length - 1].end = u.end;
    if (aus.length && u.type >= 19 && u.type <= 21) aus[aus.length - 1].key = true;
  }
  return aus.map((a) => ({ data: stream.subarray(a.start, a.end), key: a.key }));
}

export async function reencodeMovieNode(bytes, vc1, { fraction = 0.35, gop = 120, minKbps = 200, preset = 'slow' } = {}) {
  const asf = new Asf(bytes);
  const objs = asf.mediaObjects();
  const video = objs.filter((o) => o.stream === asf.videoStream);
  if (video.length < 2) return { bytes: null, why: 'no video frames' };
  const span = (video[video.length - 1].time - video[0].time) / 1000;
  const seconds = span * video.length / (video.length - 1);
  const fps = video.length / seconds;
  const sourceKbps = video.reduce((n, o) => n + o.data.length, 0) * 8 / seconds / 1000;
  const kbps = Math.max(minKbps, sourceKbps * fraction);

  const x265 = `bframes=0:keyint=${gop}:min-keyint=${gop}:scenecut=0:open-gop=0:repeat-headers=1:aud=1:info=0`;
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-s', `${asf.width}x${asf.height}`, '-r', fps.toFixed(3), '-i', '-', '-an', '-c:v', 'libx265', '-preset', preset,
    '-b:v', `${Math.round(kbps)}k`, '-x265-params', x265, '-pix_fmt', 'yuv420p', '-f', 'hevc', '-'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [], err = [];
  ff.stdout.on('data', (d) => out.push(d));
  ff.stderr.on('data', (d) => err.push(d));
  ff.stdin.on('error', () => {});
  const exited = new Promise((resolve) => ff.on('close', resolve));
  const encoded = [];  // the frames given an H.265 picture, in order
  try {
    for (const [i, i420] of showPictures(asf, video, vc1)) {
      if (!ff.stdin.write(Buffer.from(i420))) await new Promise((resolve) => ff.stdin.once('drain', resolve));
      encoded.push(i);
    }
    ff.stdin.end();
  } catch (e) {
    ff.kill();
    return { bytes: null, why: e.message || String(e) };
  }
  const code = await exited;
  if (code) return { bytes: null, why: `ffmpeg: ${Buffer.concat(err).toString().trim()}` };
  const aus = accessUnits(new Uint8Array(Buffer.concat(out)));
  if (aus.length !== encoded.length) return { bytes: null, why: `${aus.length} H.265 frames for ${encoded.length}` };
  if (!aus[0].key) return { bytes: null, why: 'the first H.265 frame is not a keyframe' };
  if (encoded[0] !== 0) return { bytes: null, why: 'the first frame is a skipped one' };
  encoded.forEach((frameIndex, k) => {
    video[frameIndex].data = aus[k].data;
    video[frameIndex].key = aus[k].key;
  });
  for (const o of video) if (isSkipped(o.data)) o.key = false;  // a skipped frame keeps its byte and is no keyframe
  return { bytes: asf.write(objs), frames: video.length, pictures: encoded.length, kbps: Math.round(kbps), why: null };
}

// ---- the check (as a command) ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, outFile] = process.argv.slice(2);
  const { default: createVc1Module } = await import(new URL('../wasm/vc1.mjs', import.meta.url).href);
  const quiet = { print: () => {}, printErr: () => {} };
  const original = new Uint8Array(readFileSync(file));
  const t0 = performance.now();
  const r = await reencodeMovieNode(original, await createVc1Module(quiet));
  if (!r.bytes) throw new Error(`${file}: kept as WMV (${r.why})`);
  console.log(`${file}: ${(original.length / 1048576).toFixed(2)} MB -> ${(r.bytes.length / 1048576).toFixed(2)} MB ` +
              `(${r.frames} frames, ${r.pictures} pictures, ${r.kbps} kbit/s) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (outFile) writeFileSync(outFile, r.bytes);

  // the copy read back against the original (the writer lays the packets out anew, so the objects of different streams
  // may interleave in another order: each stream's objects are compared in their own order)
  const a = new Asf(original), b = new Asf(r.bytes);
  const ao = a.mediaObjects(), bo = b.mediaObjects();
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const header = same(a.buf.subarray(30, a.fp), b.buf.subarray(30, b.fp)) && a.width === b.width &&
    a.height === b.height && same(a.codecData, b.codecData) && a.packetSize === b.packetSize;
  const byStream = (list) => {
    const m = new Map();
    for (const o of list) (m.get(o.stream) || m.set(o.stream, []).get(o.stream)).push(o);
    return m;
  };
  let times = ao.length === bo.length, audio = 0, audioSame = 0;
  const bs = byStream(bo);
  for (const [stream, list] of byStream(ao)) {
    const other = bs.get(stream) || [];
    if (other.length !== list.length) times = false;
    list.forEach((o, i) => {
      if (!other[i] || other[i].time !== o.time) times = false;
      if (stream !== a.videoStream) {
        ++audio;
        if (other[i] && same(o.data, other[i].data)) ++audioSame;
      }
    });
  }
  console.log(`read back: header before the file properties ${header ? 'the same' : 'DIFFERENT'}; ${bo.length} objects ` +
              `(${ao.length} before), streams and times ${times ? 'the same' : 'DIFFERENT'}; audio objects ${audioSame} ` +
              `of ${audio} byte for byte`);

  // PSNR: the pictures the game's decoder shows against ffmpeg's decode of the H.265 frames
  const hv = bo.filter((o) => o.stream === b.videoStream && !isSkipped(o.data));
  const dec = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'hevc', '-i', '-', '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p', '-'], { input: Buffer.concat(hv.map((o) => Buffer.from(o.data))), maxBuffer: 2 ** 31 });
  if (dec.status) throw new Error(String(dec.stderr));
  const ySize = a.width * a.height, frameBytes = ySize * 3 / 2;
  const psnr = [];
  let k = 0;
  for (const [, i420] of showPictures(a, ao.filter((o) => o.stream === a.videoStream), await createVc1Module(quiet))) {
    const got = dec.stdout.subarray(k * frameBytes, k * frameBytes + ySize);
    let se = 0;
    for (let i = 0; i < ySize; ++i) { const d = i420[i] - got[i]; se += d * d; }
    psnr.push(se ? 10 * Math.log10(255 * 255 / (se / ySize)) : 99);
    ++k;
  }
  const mean = psnr.reduce((n, x) => n + x, 0) / psnr.length;
  console.log(`H.265 pictures ${dec.stdout.length / frameBytes} for ${k} shown pictures; Y PSNR mean ${mean.toFixed(2)} dB, ` +
              `lowest ${Math.min(...psnr).toFixed(2)} dB (picture ${psnr.indexOf(Math.min(...psnr))})`);
}
