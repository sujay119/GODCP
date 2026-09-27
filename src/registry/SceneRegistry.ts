import { join } from 'node:path';
import { z } from 'zod';
import { createLogger, type Logger } from '../utils/logger.js';
import { ensureDir, readJson, tryReadJson, writeJson } from '../utils/fileSystem.js';

export const projectMetaSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  referenceImage: z.string().optional(),
  sceneName: z.string().optional(),
  lastStage: z.string().optional(),
  status: z.enum(['active', 'completed', 'failed']).default('active'),
});

export type ProjectMeta = z.infer<typeof projectMetaSchema>;

interface ProjectRegistryFile {
  schemaVersion: '1.0';
  updatedAt: string;
  projects: ProjectMeta[];
}

/** Registry of environment projects (state/projects/<name>). */
export class SceneRegistry {
  private readonly file: string;
  private readonly projectsDir: string;
  private readonly log: Logger;

  constructor(stateDir: string, logger?: Logger) {
    this.projectsDir = join(stateDir, 'projects');
    this.file = join(stateDir, 'registry', 'projects.json');
    this.log = logger ?? createLogger('SceneRegistry');
  }

  private async load(): Promise<ProjectRegistryFile> {
    const data = await tryReadJson<ProjectRegistryFile>(this.file);
    if (data && Array.isArray(data.projects)) return data;
    return { schemaVersion: '1.0', updatedAt: new Date().toISOString(), projects: [] };
  }

  private async save(file: ProjectRegistryFile): Promise<void> {
    file.updatedAt = new Date().toISOString();
    await ensureDir(join(this.file, '..'));
    await writeJson(this.file, file);
  }

  async upsert(meta: Omit<ProjectMeta, 'createdAt' | 'updatedAt'> & { createdAt?: string }): Promise<ProjectMeta> {
    const file = await this.load();
    const now = new Date().toISOString();
    const existing = file.projects.find((p) => p.name === meta.name);
    if (existing) {
      Object.assign(existing, meta, { updatedAt: now });
      await this.save(file);
      return existing;
    }
    const created: ProjectMeta = projectMetaSchema.parse({ ...meta, createdAt: meta.createdAt ?? now, updatedAt: now });
    file.projects.push(created);
    await this.save(file);
    this.log.info('Registered project', { name: created.name });
    return created;
  }

  async list(): Promise<ProjectMeta[]> {
    const file = await this.load();
    return [...file.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(name: string): Promise<ProjectMeta | undefined> {
    const file = await this.load();
    return file.projects.find((p) => p.name === name);
  }

  get projectsDirectory(): string {
    return this.projectsDir;
  }
}
