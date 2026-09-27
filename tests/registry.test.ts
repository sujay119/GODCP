import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetRegistry } from '../src/registry/AssetRegistry.js';

describe('AssetRegistry', () => {
  let dir: string;
  let registry: AssetRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'GODCP-registry-'));
    registry = new AssetRegistry(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    source: 'meshy' as const,
    sourceTaskId: `task-${id}`,
    localPath: join(dir, `${id}.glb`),
    hash: `hash-${id}`,
    metadata: {},
    tags: ['building', 'brick', 'house'],
    category: 'building',
    description: 'red brick house',
    ...extra,
  });

  it('registers and retrieves entries', async () => {
    await registry.register(entry('brick_house_a'));
    const got = await registry.get('brick_house_a');
    expect(got?.category).toBe('building');
    expect(await registry.count()).toBe(1);
  });

  it('replaces an entry on re-register (upsert)', async () => {
    await registry.register(entry('brick_house_a'));
    await registry.register(entry('brick_house_a', { description: 'updated' }));
    expect(await registry.count()).toBe(1);
    expect((await registry.get('brick_house_a'))?.description).toBe('updated');
  });

  it('findSimilar matches on category/description/tags', async () => {
    await registry.register(entry('brick_house_a'));
    await registry.register(entry('oak_tree_a', { category: 'vegetation', tags: ['tree', 'oak'], description: 'large oak tree' }));
    const matches = await registry.findSimilar({ description: 'brick house building', category: 'building' }, 0.4);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].entry.id).toBe('brick_house_a');
    expect(matches[0].score).toBeGreaterThanOrEqual(0.4);
  });

  it('findSimilar respects the threshold', async () => {
    await registry.register(entry('oak_tree_a', { category: 'vegetation', tags: ['tree'], description: 'oak tree' }));
    const matches = await registry.findSimilar({ description: 'sports car vehicle', category: 'vehicle' }, 0.6);
    expect(matches).toHaveLength(0);
  });

  it('persists across instances (same state dir)', async () => {
    await registry.register(entry('brick_house_a'));
    const fresh = new AssetRegistry(dir);
    expect(await fresh.count()).toBe(1);
    expect(await fresh.get('brick_house_a')).toBeDefined();
  });

  it('remove deletes entries', async () => {
    await registry.register(entry('brick_house_a'));
    expect(await registry.remove('brick_house_a')).toBe(true);
    expect(await registry.count()).toBe(0);
  });
});
