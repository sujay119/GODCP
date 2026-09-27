import { join } from 'node:path';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir, pathExists, readJson, tryReadJson, writeJson } from '../utils/fileSystem.js';
import { hashObject, shortHash } from '../utils/hashing.js';
import type { GeneratedAsset } from '../models/AssetSpec.js';

interface CacheEntry {
  key: string;
  asset: GeneratedAsset;
  createdAt: string;
}

/**
 * Filesystem cache keyed by a deterministic hash of the generation request
 * (prompt/image + options). Identical requests never re-bill the Meshy API.
 */
export class MeshyCache {
  private readonly dir: string;
  private readonly log: Logger;

  constructor(cacheDir: string, logger?: Logger) {
    this.dir = cacheDir;
    this.log = logger ?? createLogger('Meshy:Cache');
  }

  static keyFor(request: Record<string, unknown>): string {
    return shortHash(hashObject(request), 24);
  }

  private entryPath(key: string): string {
    return join(this.dir, key, 'entry.json');
  }

  async get(key: string): Promise<GeneratedAsset | undefined> {
    const entry = await tryReadJson<CacheEntry>(this.entryPath(key));
    if (!entry?.asset?.primaryFile) return undefined;
    if (!(await pathExists(entry.asset.primaryFile))) {
      this.log.debug('Cache entry primary file missing', { key });
      return undefined;
    }
    this.log.debug('Cache hit', { key, assetId: entry.asset.assetId });
    return { ...entry.asset, source: 'cache' };
  }

  async put(key: string, asset: GeneratedAsset): Promise<void> {
    const dir = join(this.dir, key);
    await ensureDir(dir);
    const entry: CacheEntry = { key, asset, createdAt: new Date().toISOString() };
    await writeJson(this.entryPath(key), entry);
    this.log.debug('Cached generated asset', { key, assetId: asset.assetId });
  }

  async list(): Promise<CacheEntry[]> {
    const { readdir } = await import('node:fs/promises');
    if (!(await pathExists(this.dir))) return [];
    const names = await readdir(this.dir, { withFileTypes: true });
    const entries: CacheEntry[] = [];
    for (const n of names) {
      if (!n.isDirectory()) continue;
      const entry = await tryReadJson<CacheEntry>(this.entryPath(n.name));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async size(): Promise<number> {
    return (await this.list()).length;
  }

  async readEntry(key: string): Promise<CacheEntry | undefined> {
    return readJson<CacheEntry>(this.entryPath(key)).catch(() => undefined);
  }
}
