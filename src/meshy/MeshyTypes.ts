import { z } from 'zod';

/** Task lifecycle statuses (verified against Meshy OpenAPI spec). */
export const meshyTaskStatusEnum = z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']);
export type MeshyTaskState = z.infer<typeof meshyTaskStatusEnum>;

export type MeshyTaskKind = 'text' | 'image';

export const meshyModelUrlsSchema = z
  .object({
    glb: z.string().optional(),
    fbx: z.string().optional(),
    gltf: z.string().optional(),
    usdz: z.string().optional(),
    obj: z.string().optional(),
    mtl: z.string().optional(),
    vox: z.string().optional(),
    blend: z.string().optional(),
    stl: z.string().optional(),
    '3mf': z.string().optional(),
    pre_remeshed_glb: z.string().optional(),
  })
  .passthrough();

export const meshyTextureUrlsSchema = z
  .object({
    base_color: z.string().optional(),
    metallic: z.string().optional(),
    roughness: z.string().optional(),
    normal: z.string().optional(),
    emission: z.string().optional(),
    metallic_roughness: z.string().optional(),
  })
  .passthrough();

export const meshyTaskErrorSchema = z
  .object({
    type: z.string().optional(),
    code: z.string().optional(),
    message: z.string().default('unknown task error'),
    doc_url: z.string().optional(),
  })
  .passthrough();

/** Universal Meshy task object (verified required fields: id, status, created_at, progress). */
export const meshyTaskSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    mode: z.string().optional(),
    name: z.string().optional(),
    prompt: z.string().optional(),
    status: meshyTaskStatusEnum,
    progress: z.number().min(0).max(100),
    created_at: z.number().optional(),
    started_at: z.number().optional(),
    finished_at: z.number().optional(),
    expires_at: z.number().optional(),
    preceding_tasks: z.number().optional(),
    model_urls: meshyModelUrlsSchema.optional(),
    model_url: z.string().optional(),
    thumbnail_url: z.string().optional(),
    alpha_thumbnail_url: z.string().optional(),
    texture_urls: z.array(meshyTextureUrlsSchema).optional(),
    task_error: meshyTaskErrorSchema.nullable().optional(),
    consumed_credits: z.number().nullable().optional(),
  })
  .passthrough();

export type MeshyTask = z.infer<typeof meshyTaskSchema>;

export const meshyCreateTaskResponseSchema = z
  .object({
    result: z.string(),
  })
  .passthrough();

export type MeshyCreateTaskResponse = z.infer<typeof meshyCreateTaskResponseSchema>;

/** Provider-agnostic handle returned when a generation is started. */
export interface MeshyTaskHandle {
  taskId: string;
  kind: MeshyTaskKind;
  assetId: string;
  strategy: 'preview' | 'refine' | 'fused' | 'image';
  createdAt: string;
}

/** Normalized task status used across the codebase. */
export interface MeshyTaskStatus {
  id: string;
  kind: MeshyTaskKind;
  status: MeshyTaskState;
  progress: number;
  modelUrls: Record<string, string>;
  textureUrls: Array<Record<string, string>>;
  thumbnailUrl?: string;
  taskError?: { type?: string; code?: string; message: string; doc_url?: string };
  consumedCredits?: number;
  prompt?: string;
  raw: MeshyTask;
}

export type TextStrategy = 'two_step' | 'fused' | 'preview_only';

export interface WaitOptions {
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  onProgress?: (progress: number, state: MeshyTaskState) => void;
  signal?: AbortSignal;
}

export const DEFAULT_WAIT_OPTIONS: Required<Pick<WaitOptions, 'timeoutMs' | 'initialIntervalMs' | 'maxIntervalMs'>> = {
  timeoutMs: 10 * 60 * 1000,
  initialIntervalMs: 1500,
  maxIntervalMs: 8000,
};

export function normalizeTask(task: MeshyTask, kind: MeshyTaskKind): MeshyTaskStatus {
  const modelUrls: Record<string, string> = {};
  if (task.model_urls) {
    for (const [k, v] of Object.entries(task.model_urls)) {
      if (typeof v === 'string' && v.length > 0) modelUrls[k] = v;
    }
  } else if (typeof task.model_url === 'string' && task.model_url.length > 0) {
    modelUrls.glb = task.model_url;
  }
  const textureUrls = (task.texture_urls ?? []).map((t) => ({ ...t }) as Record<string, string>);
  const status: MeshyTaskStatus = {
    id: task.id,
    kind,
    status: task.status,
    progress: task.progress ?? 0,
    modelUrls,
    textureUrls,
    raw: task,
  };
  if (task.thumbnail_url) status.thumbnailUrl = task.thumbnail_url;
  if (task.task_error && task.task_error.message) status.taskError = { ...task.task_error };
  if (typeof task.consumed_credits === 'number') status.consumedCredits = task.consumed_credits;
  if (task.prompt) status.prompt = task.prompt;
  return status;
}
