// Applies an XEX patch (a title update's default.xexp) to the decompressed image of the base default.xex, as the
// ReXGlue runtime does when it loads the game (peggle1-nx's sdk/src/system/xex_module.cpp, XexModule::ApplyPatch, and
// lzxdelta_apply_patch in sdk/src/system/lzx.cpp), so the page sees the executable the console runs.
//
// Peggle's Title Update #3 changes one of the 82 shader containers the executable stores; the console looks shaders up
// by the patched container, so the page translates the patched one.
//
// The steps, in the runtime's order:
//   1. The base header gets the header delta (the descriptor's first record, an LZX delta over the header bytes).
//   2. Keys: the patched header's AES key, decrypted with the retail key, is the base session key; the patch's AES
//      key decrypted with that is the patch's session key. The descriptor's image key source, decrypted with the base
//      session key, must be the session key of the unpatched base (the runtime's check).
//   3. The patch body is decrypted (AES-128-CBC, IV 0) and read block by block: each block's SHA-1 is checked, and its
//      records (fill with zeros, copy within the image, or LZX delta with the old bytes as reference) change the image.
// lzxDelta(compressed, windowBits, size, reference) decodes one delta record (wasm/lzxdelta.mjs).

import { RETAIL_KEY, decryptNoPadding, sameBytes, sha1, u32 } from './xex.js';

const DELTA_PATCH_DESCRIPTOR = 0x000005ff;
const FILE_FORMAT_INFO = 0x000003ff;

function u16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function optionalHeader(xex, key) {
  const count = u32(xex, 20);
  for (let i = 0; i < count; i++) {
    if (u32(xex, 24 + 8 * i) === key) {
      return u32(xex, 28 + 8 * i);
    }
  }
  return 0;
}

// One AES-128 block decrypted (the runtime's aes_decrypt_buffer on 16 bytes).
async function decryptBlock(key, block) {
  return decryptNoPadding(block, key);
}

// lzxdelta_apply_patch: the records in `records` applied to `dest` in place.
async function applyRecords(records, windowBits, dest, lzxDelta) {
  let at = 0;
  while (at + 12 <= records.length) {
    const oldAddr = u32(records, at);
    const newAddr = u32(records, at + 4);
    const size = u16(records, at + 8);
    const compressed = u16(records, at + 10);
    if (!compressed && !size && !newAddr && !oldAddr) {
      break;
    }
    if (newAddr + size > dest.length || oldAddr + size > dest.length) {
      throw new Error('XEX patch: a record outside its target');
    }
    if (compressed === 0) {
      dest.fill(0, newAddr, newAddr + size);
      at += 12;
    } else if (compressed === 1) {
      dest.copyWithin(newAddr, oldAddr, oldAddr + size);
      at += 12;
    } else {
      if (at + 12 + compressed > records.length) {
        throw new Error('XEX patch: a record runs past its block');
      }
      const out = await lzxDelta(records.subarray(at + 12, at + 12 + compressed), windowBits, size,
        dest.slice(oldAddr, oldAddr + size));
      if (out.length !== size) {
        throw new Error('XEX patch: an LZX delta record gave the wrong size');
      }
      dest.set(out, newAddr);
      at += 12 + compressed;
    }
  }
}

// baseXex: the base default.xex file; baseImage: its decompressed image (lib/xex.js readXexImage); xexp: the patch.
// Returns { image, header } (the patched image and the patched base header).
export async function applyXexPatch(baseXex, baseImage, xexp, lzxDelta) {
  if (u32(xexp, 0) !== 0x58455832) {
    throw new Error('the title update\'s default.xexp is not an XEX2 file');
  }
  const desc = optionalHeader(xexp, DELTA_PATCH_DESCRIPTOR);
  const format = optionalHeader(xexp, FILE_FORMAT_INFO);
  if (!desc || !format) {
    throw new Error('default.xexp has no delta patch descriptor');
  }
  const types = u32(xexp, format + 4);
  const encryption = types >>> 16;
  // XEX_COMPRESSION_DELTA (3): the "normal" compression info's layout (window, then the first block), blocks of records
  if ((types & 0xffff) !== 3) {
    throw new Error('default.xexp: not a delta patch');
  }
  const window = u32(xexp, format + 8);
  const windowBits = Math.log2(window);
  if (!Number.isInteger(windowBits)) {
    throw new Error('default.xexp: invalid LZX window');
  }

  // 1. The header.
  const baseHeaderSize = u32(baseXex, 8);
  let header = baseXex.slice(0, baseHeaderSize);
  const baseSecurity = u32(header, 16);
  const originalKey = await decryptBlock(RETAIL_KEY, header.slice(baseSecurity + 0x150, baseSecurity + 0x160));
  const digest = await sha1(header.subarray(baseSecurity + 8, baseSecurity + 8 + 0x100));
  if (!sameBytes(digest, xexp.subarray(desc + 0x0c, desc + 0x20))) {
    throw new Error('default.xexp is not a patch of this default.xex');
  }
  const targetHeaders = u32(xexp, desc + 0x30);
  const headersSourceOffset = u32(xexp, desc + 0x34);
  const headersSourceSize = u32(xexp, desc + 0x38);
  const headersTargetOffset = u32(xexp, desc + 0x3c);
  if (headersSourceOffset > baseHeaderSize || headersSourceSize > baseHeaderSize - headersSourceOffset ||
    headersTargetOffset > targetHeaders || headersSourceSize > targetHeaders - headersTargetOffset) {
    throw new Error('default.xexp: header patch outside the header');
  }
  const headerTargetSize = targetHeaders || headersTargetOffset + headersSourceSize;
  if (headerTargetSize > header.length) {
    const grown = new Uint8Array(headerTargetSize);
    grown.set(header);
    header = grown;
  }
  if (headersSourceOffset) {
    header.copyWithin(headersTargetOffset, headersSourceOffset, headersSourceOffset + headersSourceSize);
  }
  if (headerTargetSize < header.length) {
    header.fill(0, headerTargetSize);
  }
  const headerRecord = xexp.subarray(desc + 0x4c, desc + 0x4c + u16(xexp, desc + 0x4c + 10) + 0x0c);
  await applyRecords(headerRecord, windowBits, header, lzxDelta);
  if (header.length > headerTargetSize) {
    header = header.slice(0, headerTargetSize);
  }

  // 2. The keys.
  const security = u32(header, 16);
  const newImageSize = u32(header, security + 4);
  const baseKey = await decryptBlock(RETAIL_KEY, header.slice(security + 0x150, security + 0x160));
  const patchSecurity = u32(xexp, 16);
  const patchKey = await decryptBlock(baseKey, xexp.slice(patchSecurity + 0x150, patchSecurity + 0x160));
  const check = await decryptBlock(baseKey, xexp.slice(desc + 0x20, desc + 0x30));
  if (!sameBytes(check, originalKey)) {
    throw new Error('default.xexp: its image key does not match this default.xex');
  }

  // 3. The image.
  let body = xexp.slice(u32(xexp, 8));
  if (encryption === 1) {
    body = await decryptNoPadding(body.slice(0, body.length - (body.length % 16)), patchKey);
  } else if (encryption !== 0) {
    throw new Error('default.xexp: unsupported encryption');
  }
  const originalSize = baseImage.length;
  const image = new Uint8Array(Math.max(originalSize, newImageSize));
  image.set(baseImage);
  const imageSourceOffset = u32(xexp, desc + 0x40);
  const imageSourceSize = u32(xexp, desc + 0x44);
  const imageTargetOffset = u32(xexp, desc + 0x48);
  if (imageSourceOffset) {
    image.copyWithin(imageTargetOffset, imageSourceOffset, imageSourceOffset + imageSourceSize);
  }
  const imageTargetSize = imageTargetOffset + imageSourceSize;
  if (imageTargetSize < originalSize) {
    image.fill(0, imageTargetSize, originalSize);
  }
  let blockSize = u32(xexp, format + 12);
  let blockHash = xexp.slice(format + 16, format + 36);
  let at = 0;
  while (blockSize) {
    if (at + blockSize > body.length || blockSize < 24) {
      throw new Error('default.xexp: a block outside the patch');
    }
    const block = body.subarray(at, at + blockSize);
    if (!sameBytes(await sha1(block), blockHash)) {
      throw new Error('default.xexp: wrong SHA-1 in a patch block');
    }
    const next = u32(block, 0);
    const nextHash = block.slice(4, 24);
    await applyRecords(block.subarray(24), windowBits, image, lzxDelta);
    at += blockSize;
    blockSize = next;
    blockHash = nextHash;
  }
  return { image: image.slice(0, newImageSize), header };
}

// The LZX delta step of applyXexPatch, done by wasm/lzxdelta.mjs.
export function lzxDeltaStep(module) {
  return async (compressed, windowBits, size, reference) => {
    module.FS.writeFile('/delta.lzx', compressed);
    module.FS.writeFile('/delta.ref', reference);
    const rc = module.callMain(['/delta.lzx', '/delta.out', String(windowBits), String(size), '/delta.ref']);
    if (rc) {
      throw new Error(`LZX delta decompression failed (${rc})`);
    }
    const out = module.FS.readFile('/delta.out');
    module.FS.unlink('/delta.lzx');
    module.FS.unlink('/delta.ref');
    module.FS.unlink('/delta.out');
    return out;
  };
}
