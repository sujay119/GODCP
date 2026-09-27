import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateExampleReference } from '../src/cli/exampleImage.js';
import { SceneComparator } from '../src/vision/SceneComparator.js';
import { HeuristicVisionProvider } from '../src/vision/HeuristicVisionProvider.js';

describe('SceneComparator', () => {
  let dir: string;
  let ref: string;
  let render: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'GODCP-cmp-'));
    ref = await generateExampleReference(join(dir, 'ref.png'), 'cmp-ref');
    render = await generateExampleReference(join(dir, 'render.png'), 'cmp-ref');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('identical images score near-perfect similarity', async () => {
    const result = await new SceneComparator(new HeuristicVisionProvider()).compare(ref, render);
    expect(result.overallSimilarity).toBeGreaterThan(0.95);
    expect(result.method).toBe('heuristic');
    expect(result.corrections).toHaveLength(0);
  });

  it('different images produce differences + corrections', async () => {
    // Build a deliberately alien render: flat magenta frame (not a seeded reference).
    const { PNG } = await import('pngjs');
    const png = new PNG({ width: 320, height: 180 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 220;
      png.data[i + 1] = 30;
      png.data[i + 2] = 160;
      png.data[i + 3] = 255;
    }
    const other = join(dir, 'alien.png');
    await new Promise<void>((resolve, reject) => {
      const stream = png.pack();
      const ws = createWriteStream(other);
      stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      stream.pipe(ws);
    });

    const result = await new SceneComparator(new HeuristicVisionProvider()).compare(ref, other);
    expect(result.overallSimilarity).toBeLessThan(0.95);
    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.corrections.length).toBeGreaterThan(0);
    for (const c of result.corrections) {
      expect(c.action).toBeTruthy();
      expect(c.target).toBeTruthy();
      expect(c.confidence).toBeGreaterThan(0);
    }
  });

  it('throws VISION_INVALID_IMAGE for missing files', async () => {
    const cmp = new SceneComparator(new HeuristicVisionProvider());
    await expect(cmp.compare(join(dir, 'missing.png'), render)).rejects.toMatchObject({ code: 'VISION_INVALID_IMAGE' });
  });
});
