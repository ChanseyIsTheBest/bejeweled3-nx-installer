// lib/audio.js's encoder on a PC (Node has no WebCodecs): ffmpeg's libopus, 20 ms packets, VBR, as
// sasrt-nx-installer's test/xmop_node.mjs (credit culdcept-nx-installer's test/audio_node.mjs). The page's packages use
// the browser's libopus instead: the same format, the encoder's own bits.
// FFMPEG (env): ffmpeg with libopus (default C:/ffmpeg/ffmpeg.exe).
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'C:/ffmpeg/ffmpeg.exe';

// Ogg pages -> packets (RFC 3533): the first is OpusHead (its pre-skip), the second OpusTags.
function oggPackets(bytes) {
  const packets = [];
  let cur = [];
  for (let at = 0; at + 27 <= bytes.length;) {
    if (bytes[at] !== 0x4f || bytes[at + 1] !== 0x67 || bytes[at + 2] !== 0x67 || bytes[at + 3] !== 0x53) throw new Error('bad Ogg page');
    const segs = bytes[at + 26];
    let data = at + 27 + segs;
    for (let i = 0; i < segs; ++i) {
      const len = bytes[at + 27 + i];
      cur.push(bytes.subarray(data, data + len));
      data += len;
      if (len < 255) {
        const n = cur.reduce((s, c) => s + c.length, 0), p = new Uint8Array(n);
        let o = 0;
        for (const c of cur) { p.set(c, o); o += c.length; }
        packets.push(p);
        cur = [];
      }
    }
    at = data;
  }
  return packets;
}

// One sound's samples (interleaved floats at `rate`, 48000 or 24000) as Opus: { packets, preSkip48 }.
export function encodeOpus(pcm, channels, rate, bitrate) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(rate), '-ac', String(channels),
      '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', String(bitrate), '-vbr', 'on', '-application', 'audio',
      '-frame_duration', '20', '-compression_level', '10', '-f', 'ogg', 'pipe:1']);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code) return reject(new Error(`ffmpeg ${code}: ${err}`));
      const packets = oggPackets(new Uint8Array(Buffer.concat(chunks)));
      const head = packets[0];
      if (!head || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') return reject(new Error('no OpusHead'));
      resolve({ preSkip48: head[10] | (head[11] << 8), packets: packets.slice(2) });
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });
}
