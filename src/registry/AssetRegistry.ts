import { join } from 'node:path';
import { z } from 'zod';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir, readJson, tryReadJson, writeJson } from '../utils/fileSystem.js';

export const registryEntrySchema = z.object({
  id: z.string().min(1),
  source: z.enum(['meshy', 'procedural', 'primitive', 'existing', 'manual']),
  sourceTaskId: z.string().optional(),
  localPath: z.string(),
  unityPath: z.string().optional(),
  hash: z.string(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string(),
  tags: z.array(z.string()).default([]),
  category: z.string().optional(),
  description: z.string().optional(),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

export interface RegistryFile {
  schemaVersion: '1.0';
  updatedAt: string;
  entries: RegistryEntry[];
}

export interface FindSimilarQuery {
  description?: string;
  category?: string;
  tags?: string[];
  limit?: number;
}

export interface FindSimilarResult {
  entry: RegistryEntry;
  score: number;
  matchedOn: string[];
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'or', 'for', 'on', 'in', 'at', 'to', 'is', 'by']);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Persistent asset registry. Before generating anything, the asset pipeline
 * consults this registry — sufficiently similar entries are REUSED instead of
 * regenerated, which is the primary cost-control mechanism.
 */
export class AssetRegistry {
  private readonly file: string;
  private readonly dir: string;
  private readonly log: Logger;
  private cache?: RegistryFile;

  constructor(stateDir: string, logger?: Logger) {
    this.dir = join(stateDir, 'registry');
    this.file = join(this.dir, 'assets.json');
    this.log = logger ?? createLogger('Registry');
  }

  async load(): Promise<RegistryFile> {
    if (this.cache) return this.cache;
    const data = await tryReadJson<RegistryFile>(this.file);
    if (data && Array.isArray(data.entries)) {
      this.cache = data;
      return data;
    }
    this.cache = { schemaVersion: '1.0', updatedAt: new Date().toISOString(), entries: [] };
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (!this.cache) return;
    this.cache.updatedAt = new Date().toISOString();
    await ensureDir(this.dir);
    await writeJson(this.file, this.cache);
  }

  async register(entry: Omit<RegistryEntry, 'createdAt'> & { createdAt?: string }): Promise<RegistryEntry> {
    const parsed = registryEntrySchema.parse({
      ...entry,
      createdAt: entry.createdAt ?? new Date().toISOString(),
    });
    const data = await this.load();
    const existingIdx = data.entries.findIndex((e) => e.id === parsed.id);
    if (existingIdx >= 0) {
      data.entries[existingIdx] = parsed;
      this.log.debug('Updated registry entry', { id: parsed.id });
    } else {
      data.entries.push(parsed);
      this.log.info('Registered asset', { id: parsed.id, source: parsed.source });
    }
    await this.persist();
    return parsed;
  }

  async get(id: string): Promise<RegistryEntry | undefined> {
    const data = await this.load();
    return data.entries.find((e) => e.id === id);
  }

  async list(): Promise<RegistryEntry[]> {
    const data = await this.load();
    return [...data.entries];
  }

  async remove(id: string): Promise<boolean> {
    const data = await this.load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    if (data.entries.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  /**
   * Find a sufficiently similar existing asset.
   * Score = 0.55·description token similarity + 0.25·tag overlap + 0.20·category match.
   * Scores ≥ threshold (default 0.45) are considered reusable.
   */
  async findSimilar(query: FindSimilarQuery, threshold = 0.45): Promise<FindSimilarResult[]> {
    const data = await this.load();
    const queryTokens = new Set(tokenize(query.description ?? ''));
    const queryTags = new Set((query.tags ?? []).map((t) => t.toLowerCase()));
    const results: FindSimilarResult[] = [];

    for (const entry of data.entries) {
      const matchedOn: string[] = [];
      let score = 0;

      const entryTokens = new Set(tokenize(`${entry.description ?? ''} ${entry.id} ${(entry.tags ?? []).join(' ')}`));
      const descSim = queryTokens.size > 0 ? jaccard(queryTokens, entryTokens) : 0;
      if (descSim > 0) {
        score += 0.55 * descSim;
        matchedOn.push(`description(${descSim.toFixed(2)})`);
      }

      const entryTags = new Set((entry.tags ?? []).map((t) => t.toLowerCase()));
      const tagOverlap = queryTags.size > 0 ? jaccard(queryTags, entryTags) : 0;
      if (tagOverlap > 0) {
        score += 0.25 * tagOverlap;
        matchedOn.push(`tags(${tagOverlap.toFixed(2)})`);
      }

      if (query.category && entry.category) {
        if (query.category.toLowerCase() === entry.category.toLowerCase()) {
          score += 0.2;
          matchedOn.push('category');
        }
      }

      if (score >= threshold) results.push({ entry, score, matchedOn });
    }

    results.sort((a, b) => b.score - a.score);
    const limit = query.limit ?? 5;
    return results.slice(0, limit);
  }

  async count(): Promise<number> {
    return (await this.load()).entries.length;
  }
}
