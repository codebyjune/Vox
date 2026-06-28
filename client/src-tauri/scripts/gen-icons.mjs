// Generates the icon set Tauri expects, with zero dependencies.
// PNG (RGBA) + a PNG-in-ICO wrapper. Run: node scripts/gen-icons.mjs
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "icons");
fs.mkdirSync(OUT, { recursive: true });

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function pngFromRgba(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---- draw: gradient bg + white mic circle ----
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const r = size * 0.30; // mic head radius
  const stemTop = cy - r * 0.2;
  const stemBot = cy + r * 1.4;
  const stemW = size * 0.07;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = y / size;
      // gradient #5b8cff -> #7c5cff
      let R = Math.round(0x5b + (0x7c - 0x5b) * t);
      let G = Math.round(0x8c + (0x5c - 0x8c) * t);
      let B = 0xff;
      const A = 255;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // mic head (white circle)
      if (dist < r) {
        R = G = B = 255;
      }
      // mic stem (white rounded rect)
      else if (Math.abs(dx) < stemW && y > stemTop && y < stemBot) {
        R = G = B = 255;
      }
      // arc under stem (white)
      else if (dist > r + stemW * 0.5 && dist < r + stemW * 2.2 && dy > 0 && dy < r * 1.2) {
        R = G = B = 255;
      }
      const i = (y * size + x) * 4;
      rgba[i] = R; rgba[i + 1] = G; rgba[i + 2] = B; rgba[i + 3] = A;
    }
  }
  return pngFromRgba(size, size, rgba);
}

// ---- ICO wrapper (PNG entry) ----
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count = 1
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 => 256
  entry[1] = 0; // height 0 => 256
  entry[2] = 0; // colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8); // bytes
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png]);
}

const sizes = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];
for (const [name, size] of sizes) {
  fs.writeFileSync(path.join(OUT, name), render(size));
  console.log("wrote", name);
}
const big = render(256);
fs.writeFileSync(path.join(OUT, "icon.ico"), pngToIco(big));
console.log("wrote icon.ico");
