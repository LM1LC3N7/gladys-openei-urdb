// Generates cover.png (800x534) for gladys-openei-urdb: plain Node, no
// dependency. A clock face (time of use), a staircase of tier bars, a
// lightning bolt and a 24-hour strip of peak and off-peak slots, on a blue
// gradient (no logo of OpenEI, NREL or a utility). Drawing helpers taken from
// gladys-caiso (same author).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.4 + (y / H) * 0.6;
  return [40 + 40 * t, 70 + 60 * t, 140 + 60 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);
const amber = [255, 196, 80];
const coral = [255, 120, 100];
const mint = [120, 220, 170];
const ink = [40, 52, 90];

// A clock face: time of use.
disc(200, 230, 120, white, 0.95);
disc(200, 230, 108, [235, 240, 250]);
for (let k = 0; k < 12; k += 1) {
  const a = (k * Math.PI) / 6;
  line(
    200 + 92 * Math.cos(a),
    230 + 92 * Math.sin(a),
    200 + 102 * Math.cos(a),
    230 + 102 * Math.sin(a),
    k % 3 === 0 ? 7 : 4,
    ink,
  );
}
line(200, 230, 200 + 55 * Math.cos(-Math.PI / 3), 230 + 55 * Math.sin(-Math.PI / 3), 9, ink);
line(200, 230, 200 + 80 * Math.cos(Math.PI / 6), 230 + 80 * Math.sin(Math.PI / 6), 6, ink);
disc(200, 230, 10, coral);

// Tier bars: the price steps up with the kWh of the month.
const bars = [
  [380, 150, mint],
  [470, 215, amber],
  [560, 290, coral],
];
for (const [x, h, color] of bars) box(x, 380 - h, x + 70, 380, 10, color, 0.95);
line(370, 384, 645, 384, 4, white);

// A lightning bolt.
const bolt = [
  [700, 60],
  [655, 170],
  [690, 170],
  [660, 270],
  [745, 140],
  [705, 140],
  [735, 60],
];
for (let i = 0; i + 1 < bolt.length; i += 1) {
  line(bolt[i][0], bolt[i][1], bolt[i + 1][0], bolt[i + 1][1], 10, amber);
}

// A 24-hour strip: off-peak, the 4 pm - 9 pm peak.
for (let h = 0; h < 24; h += 1) {
  const peak = h >= 16 && h < 21;
  box(100 + h * 25, 440, 100 + h * 25 + 21, 480, 5, peak ? coral : mint, 0.9);
}

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
