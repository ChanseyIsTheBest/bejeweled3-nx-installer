// Lists the XMA sounds lib/xma_sounds.js finds in game files (reads only).
//   node test/xma_sounds_node.mjs <file> [more files]
import { readFileSync } from 'node:fs';
import { xmaSoundsIn } from '../lib/xma_sounds.js';

for (const path of process.argv.slice(2)) {
  const d = new Uint8Array(readFileSync(path));
  const kept = new Map();
  const sounds = xmaSoundsIn(d, kept);
  const by = new Map();
  let bytes = 0;
  for (const s of sounds) {
    const k = `${s.info.channels} ch ${s.info.sourceRate} Hz (as ${s.info.rate})`;
    by.set(k, (by.get(k) || 0) + 1);
    bytes += s.info.dataSize;
  }
  console.log(`${path}: ${sounds.length} sounds, ${(bytes / 1048576).toFixed(1)} MB of XMA`);
  for (const [k, n] of by) console.log(`  ${n} x ${k}`);
  for (const [why, n] of kept) console.log(`  not used: ${n} ${why}`);
}
