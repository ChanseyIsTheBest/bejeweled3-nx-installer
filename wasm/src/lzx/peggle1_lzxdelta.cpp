// peggle1_lzxdelta: one LZX delta record of an XEX patch (default.xexp), for the browser installer
// (wasm/lzxdelta.mjs, used by lib/xexp.js). It is the ReXGlue runtime's lzx_decompress with window data
// (peggle1-nx's sdk/src/system/lzx.cpp, the XEX patch path of xex_module.cpp): libmspack's lzxd with the XEX's window,
// 32 KB frames, and the old bytes of the image placed at the end of the otherwise zeroed window before decoding, so
// the record's matches can reach them. The same command line as futari_lzx (wasm/lzx.mjs) with the reference added.
//
//   peggle1_lzxdelta <input> <new output> <window bits> <output bytes> <reference file>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <vector>
#include <mspack.h>
#include <lzx.h>

extern "C" struct mspack_system* mspack_default_system;

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr, "usage: peggle1_lzxdelta <input> <new output> <window bits> <output bytes> <reference>\n");
    return 1;
  }
  const int bits = std::atoi(argv[3]);
  const long bytes = std::atol(argv[4]);
  if (bits < 15 || bits > 21 || bytes <= 0 || bytes > 512 * 1024 * 1024 || std::filesystem::exists(argv[2])) {
    return 1;
  }
  const size_t window_size = size_t(1) << bits;
  std::vector<unsigned char> reference;
  {
    FILE* f = std::fopen(argv[5], "rb");
    if (!f) {
      return 1;
    }
    std::fseek(f, 0, SEEK_END);
    reference.resize(size_t(std::ftell(f)));
    std::fseek(f, 0, SEEK_SET);
    const size_t got = reference.empty() ? 0 : std::fread(reference.data(), 1, reference.size(), f);
    std::fclose(f);
    if (got != reference.size() || reference.size() > window_size) {
      return 1;
    }
  }
  mspack_system* system = mspack_default_system;
  mspack_file* input = system->open(system, argv[1], MSPACK_SYS_OPEN_READ);
  if (!input) {
    return 1;
  }
  mspack_file* output = system->open(system, argv[2], MSPACK_SYS_OPEN_WRITE);
  if (!output) {
    system->close(input);
    return 1;
  }
  lzxd_stream* stream = lzxd_init(system, input, output, bits, 0, 0x8000, bytes, 0);
  int status = -1;
  if (stream) {
    // The runtime's lzx_decompress: zero the window, the old bytes at its end, the whole window as reference data.
    const size_t padding = window_size - reference.size();
    std::memset(&stream->window[0], 0, padding);
    if (!reference.empty()) {
      std::memcpy(&stream->window[padding], reference.data(), reference.size());
    }
    stream->ref_data_size = unsigned(window_size);
    status = lzxd_decompress(stream, bytes);
    lzxd_free(stream);
  }
  system->close(input);
  system->close(output);
  if (status || std::filesystem::file_size(argv[2]) != size_t(bytes)) {
    std::fprintf(stderr, "LZX delta failed: %d; the output is not valid\n", status);
    return 2;
  }
  return 0;
}
