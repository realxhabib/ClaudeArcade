// node --test plugin/player/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng, toCells } from "./cells.mjs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};

/** A PNG of `pixels` (rows of [r, g, b(, a)]), each row encoded with the filter `filters[y]`. */
function encode(pixels, bpp, filters) {
  const height = pixels.length;
  const width = pixels[0].length;
  const rows = pixels.map((row) => Buffer.from(row.flat()));
  const raw = [];
  rows.forEach((line, y) => {
    const f = filters[y % filters.length];
    const prev = y > 0 ? rows[y - 1] : Buffer.alloc(line.length);
    const out = Buffer.alloc(line.length);
    for (let x = 0; x < line.length; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = (line[x] - pred) & 0xff;
    }
    raw.push(Buffer.from([f]), out);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = bpp === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const picture = (w, h, alpha) =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * y * 13) & 255, ...(alpha ? [255] : [])]));

test("decodes RGB and RGBA PNGs with every filter type", () => {
  for (const bpp of [3, 4]) {
    const pixels = picture(7, 10, bpp === 4);
    const { width, height, rgba } = decodePng(encode(pixels, bpp, [0, 1, 2, 3, 4]));
    assert.equal(width, 7);
    assert.equal(height, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 7; x++) {
        const i = (y * 7 + x) * 4;
        assert.deepEqual([...rgba.subarray(i, i + 3)], pixels[y][x].slice(0, 3), `pixel ${x},${y} (bpp ${bpp})`);
      }
    }
  }
});

test("packs two pixel rows per cell: upper half block, top colour on bottom colour", () => {
  const pixels = picture(4, 5, false);
  const { columns, rows, cells } = toCells(decodePng(encode(pixels, 3, [4])));
  assert.equal(columns, 4);
  assert.equal(rows, 2); // the odd last line is dropped
  const words = new Uint32Array(new Uint8Array(Buffer.from(cells, "base64")).buffer);
  assert.equal(words.length, columns * rows * 3);
  const rgb = ([r, g, b]) => (r << 16) | (g << 8) | b;
  // Cell (column 2, row 1): pixels (2, 2) over (2, 3).
  const at = (1 * columns + 2) * 3;
  assert.equal(words[at], 0x2580);
  assert.equal(words[at + 1], rgb(pixels[2][2]));
  assert.equal(words[at + 2], rgb(pixels[3][2]));
});

test("rejects what isn't an 8-bit RGB(A) PNG", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
});
