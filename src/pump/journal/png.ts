/**
 * Small RGB PNG of the desk report lines. Used by the server download and by tests.
 * The web client draws the same lines on a canvas before navigator.share.
 */
import { crc32, deflateSync } from "node:zlib";

const FONT = glyphFont();

export function renderDeskReportPng(lines: readonly string[]): Buffer {
  const scale = 3;
  const cellW = 6 * scale;
  const cellH = 8 * scale;
  const pad = 24;
  const width = 880;
  const height = Math.max(280, pad * 2 + lines.length * cellH + 28);
  const rgb = Buffer.alloc(width * height * 3, 0);
  fill(rgb, width, 0, 0, width, height, [10, 14, 18]);
  fill(rgb, width, 0, 0, width, 8, [34, 211, 238]);
  lines.forEach((line, row) => blitLine(rgb, width, pad, pad + row * cellH, line, scale));
  return encodePng(width, height, rgb);
}

function blitLine(rgb: Buffer, width: number, x: number, y: number, line: string, scale: number): void {
  let cursor = x;
  for (const ch of line) {
    const glyph = FONT[ch] ?? FONT[ch.toUpperCase()];
    if (!glyph) {
      cursor += 6 * scale;
      continue;
    }
    for (let row = 0; row < glyph.length; row += 1) {
      const bits = glyph[row] ?? "";
      for (let col = 0; col < bits.length; col += 1) {
        if (bits[col] !== "1") continue;
        fill(rgb, width, cursor + col * scale, y + row * scale, scale, scale, [247, 247, 247]);
      }
    }
    cursor += 6 * scale;
  }
}

function fill(rgb: Buffer, width: number, x: number, y: number, w: number, h: number, color: [number, number, number]): void {
  const height = rgb.length / (width * 3);
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const i = (yy * width + xx) * 3;
      rgb[i] = color[0];
      rgb[i + 1] = color[1];
      rgb[i + 2] = color[2];
    }
  }
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + width * 3);
    raw[start] = 0;
    rgb.copy(raw, start + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function g(rows: string[]): string[] {
  return rows;
}

function glyphFont(): Record<string, string[]> {
  return {
    " ": g(["00000", "00000", "00000", "00000", "00000", "00000", "00000"]),
    A: g(["01110", "10001", "10001", "11111", "10001", "10001", "10001"]),
    B: g(["11110", "10001", "10001", "11110", "10001", "10001", "11110"]),
    C: g(["01111", "10000", "10000", "10000", "10000", "10000", "01111"]),
    D: g(["11110", "10001", "10001", "10001", "10001", "10001", "11110"]),
    E: g(["11111", "10000", "10000", "11110", "10000", "10000", "11111"]),
    F: g(["11111", "10000", "10000", "11110", "10000", "10000", "10000"]),
    G: g(["01111", "10000", "10000", "10111", "10001", "10001", "01111"]),
    H: g(["10001", "10001", "10001", "11111", "10001", "10001", "10001"]),
    I: g(["11111", "00100", "00100", "00100", "00100", "00100", "11111"]),
    J: g(["00111", "00010", "00010", "00010", "10010", "10010", "01100"]),
    K: g(["10001", "10010", "10100", "11000", "10100", "10010", "10001"]),
    L: g(["10000", "10000", "10000", "10000", "10000", "10000", "11111"]),
    M: g(["10001", "11011", "10101", "10101", "10001", "10001", "10001"]),
    N: g(["10001", "11001", "10101", "10011", "10001", "10001", "10001"]),
    O: g(["01110", "10001", "10001", "10001", "10001", "10001", "01110"]),
    P: g(["11110", "10001", "10001", "11110", "10000", "10000", "10000"]),
    Q: g(["01110", "10001", "10001", "10001", "10101", "10010", "01101"]),
    R: g(["11110", "10001", "10001", "11110", "10100", "10010", "10001"]),
    S: g(["01111", "10000", "10000", "01110", "00001", "00001", "11110"]),
    T: g(["11111", "00100", "00100", "00100", "00100", "00100", "00100"]),
    U: g(["10001", "10001", "10001", "10001", "10001", "10001", "01110"]),
    V: g(["10001", "10001", "10001", "10001", "10001", "01010", "00100"]),
    W: g(["10001", "10001", "10001", "10101", "10101", "10101", "01010"]),
    X: g(["10001", "10001", "01010", "00100", "01010", "10001", "10001"]),
    Y: g(["10001", "10001", "01010", "00100", "00100", "00100", "00100"]),
    Z: g(["11111", "00001", "00010", "00100", "01000", "10000", "11111"]),
    "0": g(["01110", "10001", "10011", "10101", "11001", "10001", "01110"]),
    "1": g(["00100", "01100", "00100", "00100", "00100", "00100", "01110"]),
    "2": g(["01110", "10001", "00001", "00010", "00100", "01000", "11111"]),
    "3": g(["11110", "00001", "00001", "01110", "00001", "00001", "11110"]),
    "4": g(["00010", "00110", "01010", "10010", "11111", "00010", "00010"]),
    "5": g(["11111", "10000", "10000", "11110", "00001", "00001", "11110"]),
    "6": g(["01110", "10000", "10000", "11110", "10001", "10001", "01110"]),
    "7": g(["11111", "00001", "00010", "00100", "01000", "01000", "01000"]),
    "8": g(["01110", "10001", "10001", "01110", "10001", "10001", "01110"]),
    "9": g(["01110", "10001", "10001", "01111", "00001", "00001", "01110"]),
    "+": g(["00000", "00100", "00100", "11111", "00100", "00100", "00000"]),
    "-": g(["00000", "00000", "00000", "11111", "00000", "00000", "00000"]),
    ".": g(["00000", "00000", "00000", "00000", "00000", "01100", "01100"]),
    ":": g(["00000", "01100", "01100", "00000", "01100", "01100", "00000"]),
    "/": g(["00001", "00010", "00010", "00100", "01000", "01000", "10000"]),
    "%": g(["11001", "11010", "00010", "00100", "01000", "01011", "10011"]),
    "(": g(["00010", "00100", "01000", "01000", "01000", "00100", "00010"]),
    ")": g(["01000", "00100", "00010", "00010", "00010", "00100", "01000"]),
    ",": g(["00000", "00000", "00000", "00000", "01100", "00100", "01000"])
  };
}
