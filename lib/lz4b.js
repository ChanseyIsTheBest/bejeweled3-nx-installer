// rr6-nx-installer (2026-11-10; taken into the PopCap ports' installers 2026-11-24, codecFor below their own): a game
// file as compressed blocks (.lz4b), written as a stream. rr6-nx's
// sdk/include/rex/filesystem/lz4_blocks.h has the format and reads it on the console; rr6-nx's tools/lz4b_pack.py
// (LZ4) and tools/zxcb_pack.cpp (ZXC) make the same files on a PC, tools/test_lz4_blocks.cpp checks either. Little-endian:
//   header, 32 bytes:  "RXLZ4BLK", u32 version (1: LZ4 blocks, 2: ZXC blocks), u32 block size, u64 size of the file,
//                      u32 block count, u32 0
//   the blocks:        each block's LZ4 or ZXC data back to back; a block that does not get smaller is stored as it is
//                      (its stored size then equals its length)
//   the index:         u32 per block, its stored size
//   footer, 16 bytes:  u64 offset of the index, "RXLZ4END"
// The blocks are compressed on several workers (pack_worker.js: LZ4 1.10.0's HC and ZXC 0.15.0 in WebAssembly) and
// written in order.
//
// rr6-nx-installer (2026-11-11, the user's hybrid): the RRM archives, which the game's loads read, as LZ4 HC 9 in
// 256 KB blocks (LZ4's decoder: ~590 MB/s on the console); every other game file (the videos, the music and the packs,
// read while they play) as ZXC 7 in 512 KB blocks (smaller: 2,971 MB against LZ4's 3,069 for those files; ~200 MB/s);
// default.xex as it is (the runtime loads it itself). rr6-nx's console runs of 2026-11-11 measured the choice.

export const CODECS = {
  lz4: { version: 1, block: 256 * 1024, level: 9 },
  zxc: { version: 2, block: 512 * 1024, level: 7 },
};
export const BLOCK = CODECS.lz4.block;
export const LEVEL = CODECS.lz4.level;
export const SUFFIX = '.lz4b';

// The codec for a file of the game folder ('lz4', 'zxc'), or null to copy it as it is.
// The PopCap ports (2026-11-24, the user: "zxc/l4z compress all the files. make sure all videos are zxc compressed"):
// the archives the game's loading screens read (PopCap .pak and .rsb, XPR2 resources, XACT wave banks) as LZ4 HC 9 in
// 256 KB blocks, decoded about three times faster than ZXC for under 0.5 % more (measured on every game's files with
// these WebAssembly codecs); the videos and every other file as ZXC 7 in 512 KB blocks; default.xex and default.xexp as
// they are (the runtime loads the module itself). A file that does not get smaller stays as it is (lib/media.js), but
// a video is always ZXC-packed.
export function codecFor(path) {
  const name = path.split('/').pop().toLowerCase();
  if (name === 'default.xex' || name === 'default.xexp') return null;
  if (/\.(pak|rsb|xpr|xwb)$/.test(name)) return 'lz4';
  return 'zxc';
}

// A video file (always ZXC-packed, the user's rule).
export const isVideo = (path) => /\.(wmv|bik|usm|sfd)$/i.test(path);

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function header(size, block = BLOCK, version = 1) {
  const h = new Uint8Array(32);
  const v = new DataView(h.buffer);
  h.set(ascii('RXLZ4BLK'), 0);
  v.setUint32(8, version, true);
  v.setUint32(12, block, true);
  v.setBigUint64(16, BigInt(size), true);
  v.setUint32(24, Math.ceil(size / block), true);
  return h;
}

export function trailer(sizes, indexOffset) {
  const t = new Uint8Array(sizes.length * 4 + 16);
  const v = new DataView(t.buffer);
  sizes.forEach((s, i) => v.setUint32(i * 4, s, true));
  v.setBigUint64(sizes.length * 4, BigInt(indexOffset), true);
  t.set(ascii('RXLZ4END'), sizes.length * 4 + 8);
  return t;
}

// The .lz4b file of `file` ({ size, read(offset, length) -> Promise<Uint8Array> }) as an async iterable of chunks.
// compress(bytes, codec) -> Promise<Uint8Array>: the block compressed with that codec (CODECS), or the block itself
// when that is not smaller. onRaw(n): n more bytes of the original read and packed (for a progress bar).
export async function* pack(file, compress, { codec = 'lz4', inFlight = 64, onRaw = null } = {}) {
  const { block, version } = CODECS[codec];
  const count = Math.ceil(file.size / block);
  const sizes = [];
  let offset = 32;
  yield header(file.size, block, version);
  const queue = [];
  // The original is read in runs of READ blocks (8 MB), the next run always on its way while the workers compress:
  // one block at a time, the reads were the limit (2 MB/s through the test server).
  const READ = 32;
  inFlight = Math.max(inFlight, READ * 2);
  let nextRead = 0;
  let pending = null;
  const readAhead = () => {
    if (pending || nextRead >= count) return;
    const first = nextRead;
    const last = Math.min(count, first + READ);
    const start = first * block;
    pending = file.read(start, Math.min(file.size, last * block) - start).then((bytes) => ({ first, last, bytes }));
    nextRead = last;
  };
  readAhead();
  while (sizes.length < count) {
    // keep up to inFlight blocks at the workers
    while (pending && queue.length + READ <= inFlight) {
      const { first, last, bytes } = await pending;
      pending = null;
      readAhead();
      for (let b = first; b < last; ++b) {
        const raw = bytes.slice((b - first) * block, Math.min(bytes.length, (b - first + 1) * block));
        const length = raw.length;  // before compress(): it may hand raw's buffer to a worker
        queue.push(compress(raw, codec).then((out) => ({ out, length })));
      }
    }
    const { out, length } = await queue.shift();
    if (out.length > length) throw new Error('a compressed block came back larger than the block');
    sizes.push(out.length);
    offset += out.length;
    if (onRaw) onRaw(length);
    yield out;
  }
  yield trailer(sizes, offset);
}

// The packed size is only known once packed: the zip entry takes the chunks as they come (lib/zip.js addStream).
