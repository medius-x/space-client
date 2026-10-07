// Placeholder app logo — a dark squircle card with a green ringed planet (a
// "space" motif), rendered as PNGs by pure math (supersampled shapes, no font
// rasterizer and no new dependencies: PNG chunks are encoded via node:zlib).
// The real logo will replace these files later; sizes are regenerated from the
// same vector-ish model, so each size stays crisp (no blurry downsampling).
//
//   electron/build/icon.png      256 — window icon + future installer base
//   electron/build/icon-48.png    48 — tray (sharp at native tray sizes)
//   src/renderer/public/logo.png  96 — the rail Home button (crisp at 48 CSS px)
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DARK_CARD = [0x1e, 0x1f, 0x22];
const PLANET = [0x23, 0xa5, 0x5a];
const RING = [0x57, 0xd9, 0x8a];
const STAR = [0xdb, 0xde, 0xe1];

/** The logo "scene" in normalized coordinates (0..1): sampled by render(). */
const SCENE = {
  card: { half: 0.461, exponent: 4.2 }, // squircle card, slightly inset
  planet: { cx: 0.5, cy: 0.525, radius: 0.205 },
  ring: { cx: 0.5, cy: 0.525, a: 0.39, b: 0.115, tilt: -24 * (Math.PI / 180), width: 0.045 },
  stars: [
    { cx: 0.235, cy: 0.235, radius: 0.022 },
    { cx: 0.785, cy: 0.185, radius: 0.016 },
    { cx: 0.775, cy: 0.775, radius: 0.013 },
  ],
};

function insideSquircle(sampleX, sampleY, half, exponent) {
  const normalizedX = Math.abs(sampleX - 0.5) / half;
  const normalizedY = Math.abs(sampleY - 0.5) / half;
  return Math.pow(normalizedX, exponent) + Math.pow(normalizedY, exponent) <= 1;
}

function insideCircle(sampleX, sampleY, cx, cy, radius) {
  const deltaX = sampleX - cx;
  const deltaY = sampleY - cy;
  return deltaX * deltaX + deltaY * deltaY <= radius * radius;
}

function insideRing(sampleX, sampleY, ring) {
  // Rotate the sample into the ring's frame, then test the elliptical annulus.
  const deltaX = sampleX - ring.cx;
  const deltaY = sampleY - ring.cy;
  const rotatedX = deltaX * Math.cos(ring.tilt) + deltaY * Math.sin(ring.tilt);
  const rotatedY = -deltaX * Math.sin(ring.tilt) + deltaY * Math.cos(ring.tilt);
  const normalized = (rotatedX / ring.a) ** 2 + (rotatedY / ring.b) ** 2;
  return normalized >= (1 - ring.width) ** 2 && normalized <= (1 + ring.width) ** 2;
}

/** Layered point test: later layers paint over earlier ones (card → ring → planet → stars). */
function colorAt(sampleX, sampleY) {
  let color = null;
  if (insideSquircle(sampleX, sampleY, SCENE.card.half, SCENE.card.exponent)) {
    color = DARK_CARD;
  }
  if (color !== null && insideRing(sampleX, sampleY, SCENE.ring)) {
    color = RING;
  }
  if (color !== null && insideCircle(sampleX, sampleY, SCENE.planet.cx, SCENE.planet.cy, SCENE.planet.radius)) {
    color = PLANET;
  }
  if (color !== null) {
    for (const star of SCENE.stars) {
      if (insideCircle(sampleX, sampleY, star.cx, star.cy, star.radius)) {
        color = STAR;
        break;
      }
    }
  }
  return color;
}

/** 4×4 supersampled RGBA render of the scene at the given size. */
function render(size) {
  const pixels = new Uint8Array(size * size * 4);
  const samplesPerAxis = 4;
  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      let hitCount = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let subY = 0; subY < samplesPerAxis; subY += 1) {
        for (let subX = 0; subX < samplesPerAxis; subX += 1) {
          const color = colorAt(
            (pixelX + (subX + 0.5) / samplesPerAxis) / size,
            (pixelY + (subY + 0.5) / samplesPerAxis) / size,
          );
          if (color !== null) {
            hitCount += 1;
            red = color[0];
            green = color[1];
            blue = color[2];
          }
        }
      }
      const offset = (pixelY * size + pixelX) * 4;
      if (hitCount > 0) {
        // Layer colors are flat, so any hit carries the top color; alpha = coverage.
        pixels[offset] = red;
        pixels[offset + 1] = green;
        pixels[offset + 2] = blue;
        pixels[offset + 3] = Math.round((hitCount / (samplesPerAxis * samplesPerAxis)) * 255);
      }
    }
  }
  return pixels;
}

// --- Minimal PNG encoder (RGBA, 8 bit, no interlace) -------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let entry = 0; entry < 256; entry += 1) {
    let value = entry;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[entry] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    raw[row * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, row * size * 4, size * 4).copy(raw, row * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputs = [
  { file: path.join(projectRoot, "electron", "build", "icon.png"), size: 256 },
  { file: path.join(projectRoot, "electron", "build", "icon-48.png"), size: 48 },
  { file: path.join(projectRoot, "src", "renderer", "public", "logo.png"), size: 96 },
];
for (const output of outputs) {
  mkdirSync(path.dirname(output.file), { recursive: true });
  writeFileSync(output.file, encodePng(render(output.size), output.size));
  console.log(`logo: wrote ${path.relative(projectRoot, output.file)} (${output.size}x${output.size})`);
}
