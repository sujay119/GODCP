import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

/**
 * Generate a deterministic synthetic "environment reference" PNG:
 * sky gradient + horizon + road + building silhouettes + sun glow.
 * Used by `godcp demo` and tests so the whole pipeline runs offline.
 */
export async function generateExampleReference(destPath: string, seed = 'GODCP'): Promise<string> {
  const width = 640;
  const height = 360;
  const png = new PNG({ width, height });
  const horizon = Math.floor(height * 0.55);
  const rand = mulberry32(hashSeed(seed));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      let r: number, g: number, b: number;

      if (y < horizon) {
        // sky: warm top → pale horizon
        const t = y / horizon;
        r = lerp(70, 210, t);
        g = lerp(110, 225, t);
        b = lerp(170, 235, t);
        // sun glow (upper right)
        const dx = x - width * 0.78;
        const dy = y - height * 0.2;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 90) {
          const glow = 1 - dist / 90;
          r = Math.min(255, r + glow * 90);
          g = Math.min(255, g + glow * 70);
          b = Math.min(255, b + glow * 20);
        }
      } else if (Math.abs(x - width / 2) < width * 0.16 + (y - horizon) * 0.35) {
        // road: dark asphalt with center line
        const cx = Math.abs(x - width / 2);
        const roadHalf = width * 0.16 + (y - horizon) * 0.35;
        if (cx > roadHalf - 4 && cx < roadHalf) {
          r = 140; g = 140; b = 145; // curb
        } else if (Math.abs(x - width / 2) < 3 && Math.floor(y / 16) % 2 === 0) {
          r = 230; g = 230; b = 220; // dashed center line
        } else {
          const shade = 55 + (y % 7);
          r = shade; g = shade; b = shade + 6;
        }
      } else {
        // ground: muted grass/asphalt blend
        const t = (y - horizon) / (height - horizon);
        r = lerp(85, 60, t);
        g = lerp(115, 85, t);
        b = lerp(70, 55, t);
      }
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }

  // building silhouettes on both sides (deterministic per seed)
  const buildings = 9;
  for (let i = 0; i < buildings; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const bw = 30 + Math.floor(rand() * 50);
    const bh = 60 + Math.floor(rand() * 130);
    const bx = side < 0 ? Math.floor(rand() * width * 0.32) : Math.floor(width * 0.68 + rand() * width * 0.3) - bw;
    const by = horizon - bh;
    const shade = 40 + Math.floor(rand() * 45);
    for (let y = Math.max(0, by); y < horizon; y++) {
      for (let x = Math.max(0, bx); x < Math.min(width, bx + bw); x++) {
        const idx = (width * y + x) << 2;
        png.data[idx] = shade;
        png.data[idx + 1] = shade;
        png.data[idx + 2] = shade + 8;
        // lit windows
        if ((x - bx) % 8 === 3 && (y - by) % 10 === 4 && rand() > 0.55) {
          png.data[idx] = 250;
          png.data[idx + 1] = 230;
          png.data[idx + 2] = 150;
        }
      }
    }
  }

  await mkdir(dirname(destPath), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  await new Promise<void>((resolve, reject) => {
    const stream = png.pack();
    const ws = createWriteStream(destPath);
    stream.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve());
    stream.pipe(ws);
  });

  return destPath;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function hashSeed(s: string): number {
  const h = createHash('sha256').update(s).digest();
  return h.readUInt32BE(0);
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
