// The PopCap ports (2026-11-24, the user: "add audio and video compression"): the XMA sounds inside a game file, for
// lib/xmop.js (sasrt-nx-installer's writer, container-agnostic once the sounds are found). Two kinds of container hold
// these games' XMA, wherever they sit in the file:
//   - RIFF WAVE files, XMA2 (fmt 0x166: Bejeweled 3's and Zuma's Revenge's main.rsb) or XMA1 (fmt 0x165: Zuma's
//     resources.xpr), little-endian, one stream, mono or stereo;
//   - XACT wave banks ("DNBW", big-endian): Feeding Frenzy's Wave Bank.xwb (version 37), the two in Feeding Frenzy 2's
//     resources2.xpr and the one in Peggle's aux_sounds.pak (version 43). The entry's format word in the newer layout
//     (the base's media-compression.md: versions 38-46; version 37 reads the same, checked by decoding: 11,025 Hz mono
//     XMA): 2 bits codec (1 = XMA), 3 bits channels, 18 bits rate, 8 bits block align, 1 bit bits per sample.
// Each sound: { info: { dataOffset, dataSize, rate, channels, sourceRate } }, its packets at dataOffset in the file,
// whole 2048-byte packets. rate is what the sound is declared as in NAME.xmop: the base's SDK plays 48,000 / 24,000 Hz
// sounds from Opus at their own rate and 44,100 Hz ones from 48 kHz Opus resampled back; any other rate (11,025, 22,050,
// XACT's 44,040 ...) is declared as 24,000 Hz (up to 24 kHz) or 48,000 Hz with its samples as they are, as kameo-nx did
// for its 22,050 Hz sounds: XMA frames are 512 samples at any rate and the game's voice keeps its own rate.

const PACKET = 2048;

const ascii = (d, at, s) => [...s].every((c, i) => d[at + i] === c.charCodeAt(0));
const le16 = (d, at) => d[at] | (d[at + 1] << 8);
const le32 = (d, at) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
const be32 = (d, at) => ((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]) >>> 0;

export const declaredRate = (rate) => ([48000, 24000, 44100].includes(rate) ? rate : rate <= 24000 ? 24000 : 48000);

function find(d, magic, from) {
  const a = magic.charCodeAt(0);
  for (let i = d.indexOf(a, from); i >= 0 && i + magic.length <= d.length; i = d.indexOf(a, i + 1)) {
    if (ascii(d, i, magic)) return i;
  }
  return -1;
}

// RIFF WAVE XMA1 / XMA2 files: [{ info }], and how many were found but cannot be used (why: count).
export function riffSounds(d, kept = new Map()) {
  const out = [];
  const keep = (why) => kept.set(why, (kept.get(why) || 0) + 1);
  for (let at = find(d, 'RIFF', 0); at >= 0; at = find(d, 'RIFF', at + 4)) {
    if (!ascii(d, at + 8, 'WAVE')) continue;
    const end = Math.min(d.length, at + 8 + le32(d, at + 4));
    let fmt = -1, fmtSize = 0, data = -1, dataSize = 0;
    for (let c = at + 12; c + 8 <= end;) {
      const size = le32(d, c + 4);
      if (ascii(d, c, 'fmt ')) { fmt = c + 8; fmtSize = size; }
      if (ascii(d, c, 'data')) { data = c + 8; dataSize = size; }
      c += 8 + size + (size & 1);
    }
    if (fmt < 0 || data < 0) continue;
    const tag = le16(d, fmt);
    let channels, rate, streams;
    if (tag === 0x166 && fmtSize >= 34) {  // XMA2WAVEFORMATEX: WAVEFORMATEX, then NumStreams
      channels = le16(d, fmt + 2);
      rate = le32(d, fmt + 4);
      streams = le16(d, fmt + 18);
    } else if (tag === 0x165 && fmtSize >= 32) {  // XMAWAVEFORMAT, then XMASTREAMFORMAT per stream
      streams = le16(d, fmt + 8);
      rate = le32(d, fmt + 12 + 4);
      channels = d[fmt + 12 + 17];
    } else {
      continue;
    }
    if (streams !== 1) { keep('more than one stream'); continue; }
    if (channels < 1 || channels > 2) { keep('not mono or stereo'); continue; }
    if (!dataSize || dataSize % PACKET) { keep('its data is not whole packets'); continue; }
    out.push({ info: { dataOffset: data, dataSize, rate: declaredRate(rate), channels, sourceRate: rate } });
    at = data + dataSize - 4;
  }
  return out;
}

// XACT wave banks (versions 37-46) anywhere in the file: their XMA entries, [{ info }].
export function xwbSounds(d, kept = new Map()) {
  const out = [];
  const keep = (why) => kept.set(why, (kept.get(why) || 0) + 1);
  for (let at = find(d, 'DNBW', 0); at >= 0; at = find(d, 'DNBW', at + 4)) {
    const version = be32(d, at + 4);
    if (version < 37 || version > 46) continue;
    const segAt = at + (version >= 42 ? 12 : 8);  // XACT 3 (42-46) has a header version word first
    if (segAt + 40 > d.length) continue;
    const seg = (k) => ({ off: be32(d, segAt + 8 * k), len: be32(d, segAt + 8 * k + 4) });
    const bank = seg(0), meta = seg(1), wave = seg(4);
    const inside = (s) => s.off + s.len <= d.length - at;
    if (!bank.len || !meta.len || !wave.len || !inside(bank) || !inside(meta) || !inside(wave)) continue;
    const count = be32(d, at + bank.off + 4);
    const metaSize = be32(d, at + bank.off + 72);
    const align = be32(d, at + bank.off + 80);
    if (!count || metaSize < 24 || metaSize * count > meta.len || align !== PACKET) continue;
    for (let e = 0; e < count; ++e) {
      const m = at + meta.off + e * metaSize;
      const format = be32(d, m + 4);
      if ((format & 3) !== 1) continue;  // not XMA
      const channels = (format >>> 2) & 7;
      const rate = (format >>> 5) & 0x3ffff;
      const offset = be32(d, m + 8), length = be32(d, m + 12);
      if (channels < 1 || channels > 2) { keep('not mono or stereo'); continue; }
      if (!length || length % PACKET || offset % PACKET || offset + length > wave.len) {
        keep('its data is not whole packets');
        continue;
      }
      out.push({ info: { dataOffset: at + wave.off + offset, dataSize: length, rate: declaredRate(rate), channels, sourceRate: rate } });
    }
  }
  // two entries can name the same data (a sound used twice): once each
  const seen = new Set();
  return out.filter((s) => (seen.has(s.info.dataOffset) ? false : seen.add(s.info.dataOffset)));
}

// Every usable XMA sound of a game file, in file order (overlaps dropped).
export function xmaSoundsIn(d, kept = new Map()) {
  const all = [...riffSounds(d, kept), ...xwbSounds(d, kept)].sort((a, b) => a.info.dataOffset - b.info.dataOffset);
  const out = [];
  let end = 0;
  for (const s of all) {
    if (s.info.dataOffset < end) continue;
    out.push(s);
    end = s.info.dataOffset + s.info.dataSize;
  }
  return out;
}
