// sasrt-nx-installer (2026-11-21, the user: "copy culdcept saga web installer for encoding audio and video"; culdcept-nx-
// installer's lib/audio.js, credit culdcept-nx), taken into the PopCap ports' installers (2026-11-24, the user: "add audio
// and video compression"): a game file NAME with XMA sounds in it (lib/xma_sounds.js finds them: RIFF XMA1 / XMA2 files
// and XACT wave banks, wherever they sit) as NAME.xmop (lib/xmop.js): each sound decoded by wasm/xma (FFmpeg's
// xmaframes decoder, frame by frame) and encoded as Opus, by the browser's encoder (WebCodecs' AudioEncoder: libopus in
// Chrome, Edge and Firefox) or a PC's (test/opus_node.mjs: ffmpeg's libopus). The port's XMA emulation plays each tagged
// frame from the Opus (the SDK's xmo.cpp / xma_context.cpp, from the ultimate base).
// Returns { parts, size, made, candidates, kept } (made: sounds as Opus; kept: [why, count]) or { parts: null, why }.
import { resample } from './resample.js';
import { decodeAll, opusCost, opusRateFor, openSound, preSkipAt, refusal, soundId, writeXmop } from './xmop.js';
import { xmaSoundsIn } from './xma_sounds.js';

const OPUS_LOOKAHEAD = 312;  // libopus's at 48 kHz (2.5 ms + 4 ms): the pre-skip when the encoder gives no OpusHead
const SAMPLES_PER_FRAME = 512;

export function opusConfig(channels, bitrate, sampleRate = 48000) {
  return {
    codec: 'opus', sampleRate, numberOfChannels: channels, bitrate, bitrateMode: 'variable',
    opus: { frameDuration: 20000, complexity: 10, application: 'audio', format: 'opus' },
  };
}

export async function canEncodeOpus() {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const ok = async (c) => !!(await AudioEncoder.isConfigSupported(c)).supported;
    return (await ok(opusConfig(2, 128000))) && (await ok(opusConfig(1, 32000, 24000)));
  } catch {
    return false;
  }
}

// One sound's samples (interleaved floats at `rate`) as Opus with WebCodecs: { packets, preSkip48 }.
export async function encodeWebCodecs(pcm, channels, rate, bitrate) {
  const packets = [];
  let preSkip48 = null, failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      packets.push(d);
      const desc = meta?.decoderConfig?.description;
      if (preSkip48 === null && desc) {
        const h = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
        if (h.length >= 12 && new TextDecoder().decode(h.subarray(0, 8)) === 'OpusHead') preSkip48 = h[10] | (h[11] << 8);
      }
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(opusConfig(channels, bitrate, rate));
  try {
    const step = 1024 * 512 * channels;
    for (let at = 0, time = 0; at < pcm.length && !failure; at += step) {
      const part = pcm.subarray(at, Math.min(pcm.length, at + step));
      const frames = part.length / channels;
      const data = new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: frames, numberOfChannels: channels,
                                   timestamp: Math.round(time * 1e6 / rate), data: part });
      encoder.encode(data);
      data.close();
      time += frames;
      while (encoder.encodeQueueSize > 4 && !failure) await new Promise((r) => setTimeout(r, 1));
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  return { packets, preSkip48: preSkip48 ?? OPUS_LOOKAHEAD };
}

// The PopCap ports' bitrates (the base's media-compression.md: the ports chose 96-128 kbit/s stereo for 48 / 44.1 kHz
// music, 48 / 32 for 24 kHz sounds): music (a sound of 20 s or more) 128 kbit/s stereo, 64 mono; shorter sounds 96 and
// 48; sounds declared 24 kHz 48 and 32.
export function bitrateFor(info) {
  const seconds = info.frames * SAMPLES_PER_FRAME / info.rate;
  if (info.rate === 24000) return info.channels === 2 ? 48000 : 32000;
  if (seconds >= 20) return info.channels === 2 ? 128000 : 64000;
  return info.channels === 2 ? 96000 : 48000;
}

// bytes: the game file; xma: an instance of wasm/xma.mjs; pack: the file's index among the game's .xmop files (the
// sound ids' second byte); encode(pcm, channels, rate, bitrate) -> { packets, preSkip48 }; jobs: encoders at once.
export async function makeXmop(bytes, xma, { pack, encode = encodeWebCodecs, jobs = 6, onSound = null } = {}) {
  const kept = new Map();
  const keep = (why) => kept.set(why, (kept.get(why) || 0) + 1);
  let candidates;
  try {
    candidates = xmaSoundsIn(bytes, kept);
  } catch (e) {
    return { parts: null, why: e.message || String(e) };
  }
  const made = [];
  const inFlight = new Set();
  let done = 0;
  for (const s of candidates) {
    const x = openSound(xma, bytes, s);
    if (!x.info) { keep(x.why); continue; }
    const why = refusal(x.info);
    if (why) { x.close(); keep(why); continue; }
    const { info } = x;
    let pcm;
    try {
      pcm = decodeAll(x);
    } catch (e) {
      keep(e.message || String(e));
      continue;
    } finally {
      x.close();
    }
    const rate = opusRateFor(info.rate);
    const input = rate === info.rate ? pcm : resample(pcm, info.channels, info.rate, rate);
    const job = encode(input, info.channels, rate, bitrateFor(info)).then((enc) => {
      const opus = { packets: enc.packets, preSkip: preSkipAt(rate, enc.preSkip48), rate };
      const cost = opusCost(info, opus);
      if (cost >= info.packets * 2048) { keep('not smaller as Opus'); return; }
      made.push({ info, dataOffset: s.info.dataOffset, opus });
    }).catch((e) => keep(`the Opus encoder failed: ${e.message || e}`))
      .finally(() => { ++done; if (onSound) onSound(done, candidates.length); });
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
    while (inFlight.size >= jobs) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  if (!made.length) return { parts: null, why: [...kept].map(([w, n]) => `${n}: ${w}`).join('; ') || 'no XMA sounds' };
  made.sort((a, b) => a.dataOffset - b.dataOffset);
  made.forEach((m, i) => { m.id = soundId(pack, i); });
  const { parts, size } = writeXmop(bytes, made);
  return { parts, size, made: made.length, candidates: candidates.length, kept: [...kept] };
}
