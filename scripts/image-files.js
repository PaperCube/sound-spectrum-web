'use strict';

(() => {
  const textEncoder = new TextEncoder();
  const crcTable = Uint32Array.from({length: 256}, (_, index) => {
    let entry = index;
    for (let bit = 0; bit < 8; bit++) entry = (entry >>> 1) ^ ((entry & 1) ? 0xedb88320 : 0);
    return entry;
  });
  const crcUpdate = (crc, bytes) => {
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return crc;
  };

  function pngChunk(type, data) {
    const prefix = new DataView(new ArrayBuffer(8));
    const name = textEncoder.encode(type);
    prefix.setUint32(0, data.length);
    new Uint8Array(prefix.buffer).set(name, 4);
    const trailer = new DataView(new ArrayBuffer(4));
    trailer.setUint32(0, crcUpdate(crcUpdate(0xffffffff, name), data) ^ 0xffffffff);
    return [prefix.buffer, data, trailer.buffer];
  }

  function fillScanlines(scanlines, width, tile, pixels) {
    const stride = width * 3 + 1;
    for (let row = 0; row < tile.height; row++) {
      let target = row * stride + 1 + tile.x * 3;
      const end = (row + 1) * tile.width * 4;
      for (let source = row * tile.width * 4; source < end; source += 4) {
        scanlines[target++] = pixels[source];
        scanlines[target++] = pixels[source + 1];
        scanlines[target++] = pixels[source + 2];
      }
    }
  }

  function filterScanlines(scanlines, width, height) {
    const stride = width * 3 + 1;
    for (let row = 0; row < height; row++) {
      const start = row * stride;
      scanlines[start] = 1; // PNG Sub filter. Process backwards to keep the previous pixel intact.
      for (let offset = start + stride - 1; offset >= start + 4; offset--) {
        scanlines[offset] -= scanlines[offset - 3];
      }
    }
  }

  SoundSpectrum.encodePNG = async function (width, height, draw, signal, onProgress) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", {alpha: false, willReadFrequently: true});
    const header = new DataView(new ArrayBuffer(13));
    header.setUint32(0, width);
    header.setUint32(4, height);
    header.setUint8(8, 8);
    header.setUint8(9, 2); // RGB
    const chunks = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      ...pngChunk("IHDR", new Uint8Array(header.buffer)),
      ...pngChunk("sRGB", new Uint8Array([0]))
    ];
    const compression = new CompressionStream("deflate");
    const writer = compression.writable.getWriter();
    const read = (async () => {
      const reader = compression.readable.getReader();
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          chunks.push(...pngChunk("IDAT", value));
        }
      } finally {
        reader.releaseLock();
      }
    })();
    read.catch(() => {});

    const stripeHeight = 128;
    const tileWidth = Math.min(width, 4096);
    try {
      for (let y = 0; y < height; y += stripeHeight) {
        signal.throwIfAborted();
        const rows = Math.min(stripeHeight, height - y);
        const scanlines = new Uint8Array(rows * (width * 3 + 1));
        for (let x = 0; x < width; x += tileWidth) {
          const tile = {x, y, width: Math.min(tileWidth, width - x), height: rows};
          if (canvas.width !== tile.width || canvas.height !== tile.height) {
            canvas.width = tile.width;
            canvas.height = tile.height;
          }
          draw(context, tile);
          fillScanlines(scanlines, width, tile, context.getImageData(0, 0, tile.width, rows).data);
        }
        filterScanlines(scanlines, width, rows);
        await writer.write(scanlines);
        onProgress(y + rows);
        if (y % (stripeHeight * 8) === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      signal.throwIfAborted();
      await writer.close();
      await read;
      return new Blob([...chunks, ...pngChunk("IEND", new Uint8Array(0))], {type: "image/png"});
    } catch (error) {
      await writer.abort(error).catch(() => {});
      await read.catch(() => {});
      throw error;
    } finally {
      canvas.width = canvas.height = 0;
    }
  };

  SoundSpectrum.makeImageZIP = async function (images, signal) {
    const files = [], directory = [];
    let offset = 0, directorySize = 0;
    for (const {name, blob} of images) {
      signal.throwIfAborted();
      const filename = textEncoder.encode(name);
      const local = new DataView(new ArrayBuffer(30));
      const record = new DataView(new ArrayBuffer(46));
      if (offset + local.byteLength + filename.length + blob.size >= 0xffffffff) {
        throw new Error("压缩包超过 4 GB，请缩小导出宽度。");
      }
      const reader = blob.stream().getReader();
      let crc = 0xffffffff;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          signal.throwIfAborted();
          crc = crcUpdate(crc, value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x800, true); // UTF-8 filenames, stored PNG data.
      local.setUint16(12, 0x21, true); // DOS date 1980-01-01
      local.setUint32(14, crc ^ 0xffffffff, true);
      local.setUint32(18, blob.size, true);
      local.setUint32(22, blob.size, true);
      local.setUint16(26, filename.length, true);
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      new Uint8Array(record.buffer, 6, 26).set(new Uint8Array(local.buffer, 4, 26));
      record.setUint32(42, offset, true);
      files.push(local.buffer, filename, blob);
      directory.push(record.buffer, filename);
      offset += local.byteLength + filename.length + blob.size;
      directorySize += record.byteLength + filename.length;
    }
    if (offset + directorySize + 22 >= 0xffffffff || images.length >= 0xffff) {
      throw new Error("压缩包超过 ZIP 容量，请缩小导出宽度。");
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, images.length, true);
    end.setUint16(10, images.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return new Blob([...files, ...directory, end.buffer], {type: "application/zip"});
  };
})();
