import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PNG } from 'pngjs';
import { GODCPError } from '../utils/errors.js';

export interface ImageStats {
  width: number;
  height: number;
  /** Grid of average colors, row-major, `rows` × `cols`. */
  grid: Array<{ r: number; g: number; b: number }>;
  rows: number;
  cols: number;
  average: { r: number; g: number; b: number };
  brightness: number;
  dominant: Array<{ r: number; g: number; b: number; count: number }>;
}

export async function isPng(path: string): Promise<boolean> {
  try {
    const fh = await readFile(path);
    return fh.length > 8 && fh[0] === 0x89 && fh[1] === 0x50 && fh[2] === 0x4e && fh[3] === 0x47;
  } catch {
    return false;
  }
}

export async function loadImageStats(path: string, cols = 8, rows = 6): Promise<ImageStats> {
  const ext = extname(path).toLowerCase();
  if (ext !== '.png' && !(await isPng(path))) {
    throw new GODCPError('VISION_INVALID_IMAGE', `Pixel analysis supports PNG images only (got "${ext || 'unknown'}"). Configure a vision LLM provider for JPEG support.`, {
      stage: 'vision',
      details: { path },
    });
  }
  let png: PNG;
  try {
    const buf = await readFile(path);
    png = PNG.sync.read(buf);
  } catch (err) {
    throw new GODCPError('VISION_INVALID_IMAGE', `Could not decode image: ${err instanceof Error ? err.message : String(err)}`, {
      stage: 'vision',
      details: { path },
      cause: err,
    });
  }

  const { width, height, data } = png;
  const grid: Array<{ r: number; g: number; b: number }> = [];
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * width) / cols);
      const x1 = Math.floor(((gx + 1) * width) / cols);
      const y0 = Math.floor((gy * height) / rows);
      const y1 = Math.floor(((gy + 1) * height) / rows);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const idx = (width * y + x) << 2;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          n++;
          const key = ((data[idx] >> 4) << 8) | ((data[idx + 1] >> 4) << 4) | (data[idx + 2] >> 4);
          const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
          bucket.r += data[idx];
          bucket.g += data[idx + 1];
          bucket.b += data[idx + 2];
          bucket.count++;
          buckets.set(key, bucket);
        }
      }
      const cell = { r: r / Math.max(1, n), g: g / Math.max(1, n), b: b / Math.max(1, n) };
      grid.push(cell);
      sumR += cell.r * n;
      sumG += cell.g * n;
      sumB += cell.b * n;
      count += n;
    }
  }

  const average = { r: sumR / count, g: sumG / count, b: sumB / count };
  const brightness = 0.299 * average.r + 0.587 * average.g + 0.114 * average.b;
  const dominant = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((bk) => ({ r: bk.r / bk.count, g: bk.g / bk.count, b: bk.b / bk.count, count: bk.count }));

  return { width, height, grid, rows, cols, average, brightness, dominant };
}

export function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
