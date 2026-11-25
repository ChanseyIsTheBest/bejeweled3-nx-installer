// pack_worker.js's compression in this Node process (test/package_node.mjs): the same WebAssembly modules (LZ4 1.10.0's
// HC, ZXC 0.15.0) and the same calls, so the package equals the page's byte for byte. compress(bytes, codec) resolves
// to the block compressed, or the block itself when that is not smaller.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODECS } from '../lib/lz4b.js';

const wasm = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wasm');
const [lz4, zxc] = await Promise.all([
  import(pathToFileURL(path.join(wasm, 'lz4.mjs')).href).then((m) => m.default()),
  import(pathToFileURL(path.join(wasm, 'zxc.mjs')).href).then((m) => m.default()),
]);
const room = { lz4: { size: 0, src: 0, dst: 0 }, zxc: { size: 0, src: 0, dst: 0 } };

function buffers(name, m, size, dstSize) {
  const r = room[name];
  if (size > r.size) {
    if (r.src) {
      m[`_${name}_free`](r.src);
      m[`_${name}_free`](r.dst);
    }
    r.size = size;
    r.src = m[`_${name}_malloc`](size);
    r.dst = m[`_${name}_malloc`](dstSize);
  }
  return r;
}

export async function compress(bytes, codec) {
  const { level, block } = CODECS[codec];
  let n;
  let m;
  let r;
  if (codec === 'zxc') {
    m = zxc;
    r = buffers('zxc', zxc, bytes.length, zxc._zxc_bound(Math.max(bytes.length, block)));
    zxc.HEAPU8.set(bytes, r.src);
    n = zxc._zxc_pack(r.src, bytes.length, r.dst, zxc._zxc_bound(bytes.length), level, block);
  } else {
    m = lz4;
    r = buffers('lz4', lz4, bytes.length, bytes.length);
    lz4.HEAPU8.set(bytes, r.src);
    n = lz4._lz4_compress(r.src, bytes.length, r.dst, bytes.length - 1, level);
  }
  return n > 0 ? m.HEAPU8.slice(r.dst, r.dst + n) : bytes;
}
