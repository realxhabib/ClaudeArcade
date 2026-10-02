// Turns a PNG frame into terminal cells for Claude Code's Raster element: each
// cell is "▀" (upper half block) with the top pixel as its foreground colour
// and the pixel below as its background, so a terminal that has no image
// support (Windows Terminal, say) still shows the game, two pixels per cell.
// No dependencies: the PNG is decoded here with node:zlib.

import { inflateSync } from "node:zlib";

const UPPER_HALF = 0x2580;

/** Decodes an 8-bit RGB or RGBA, non-interlaced PNG to `{ width, height, rgba }`. */
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error("unsupported PNG");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = y > 0 ? out - stride : -1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[out + x - bpp] : 0;
      const b = prev >= 0 ? pixels[prev + x] : 0;
      const c = prev >= 0 && x >= bpp ? pixels[prev + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[out + x] = v & 0xff;
    }
  }
  if (bpp === 4) return { width, height, rgba: pixels };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/**
 * Packs an RGBA image into Raster cells: `columns` = width, `rows` = height / 2
 * (an odd last line is dropped). Returns `{ columns, rows, cells }`, cells being
 * base64 little-endian u32 triplets `[codePoint, foreground, background]`.
 */
export function toCells({ width, height, rgba }) {
  const columns = Math.min(512, width);
  const rows = Math.min(256, Math.floor(height / 2));
  const words = new Uint32Array(columns * rows * 3);
  const rgb = (x, y) => {
    const i = (y * width + x) * 4;
    return (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
  };
  let w = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      words[w++] = UPPER_HALF;
      words[w++] = rgb(c, r * 2);
      words[w++] = rgb(c, r * 2 + 1);
    }
  }
  return { columns, rows, cells: Buffer.from(words.buffer).toString("base64") };
}
