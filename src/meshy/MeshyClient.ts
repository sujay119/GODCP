import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { sleep } from '../utils/validation.js';
import {
  meshyCreateTaskResponseSchema,
  meshyTaskSchema,
  normalizeTask,
  type MeshyTask,
  type MeshyTaskKind,
  type MeshyTaskStatus,
} from './MeshyTypes.js';
import type { MeshyGenerationSpec, MeshyImageGenerationSpec } from '../models/AssetSpec.js';
import { parseOrThrow } from '../utils/validation.js';

export interface MeshyClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Total attempts per request (including the first) for retryable failures. */
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  requestTimeoutMs?: number;
}

export interface RequestResult<T> {
  status: number;
  data: T;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function mapHttpError(status: number, message: string, stage: string): GODCPError {
  const base = { stage, details: { status, upstreamMessage: message } };
  switch (status) {
    case 401:
      return new GODCPError('MESHY_AUTH_INVALID', `Meshy API key rejected (401): ${message}`, { ...base, retryable: false });
    case 402:
      return new GODCPError('MESHY_INSUFFICIENT_CREDITS', `Insufficient Meshy credits (402): ${message}`, { ...base, retryable: false });
    case 403:
      return new GODCPError('MESHY_BAD_REQUEST', `Meshy endpoint not permitted for this key/plan (403): ${message}`, { ...base, retryable: false });
    case 404:
      return new GODCPError('NOT_FOUND', `Meshy resource not found (404): ${message}`, { ...base, retryable: false });
    case 429:
      return new GODCPError('MESHY_RATE_LIMIT', `Meshy rate limit exceeded (429): ${message}`, { ...base, retryable: true });
    case 400:
    case 422:
      return new GODCPError('MESHY_BAD_REQUEST', `Meshy rejected the request (${status}): ${message}`, { ...base, retryable: false });
    default:
      if (status >= 500) {
        return new GODCPError('MESHY_UNAVAILABLE', `Meshy server error (${status}): ${message}`, { ...base, retryable: true });
      }
      return new GODCPError('MESHY_UNAVAILABLE', `Unexpected Meshy response (${status}): ${message}`, { ...base, retryable: status >= 500 });
  }
}

/**
 * Low-level Meshy REST client. Endpoints/auth verified against
 * https://docs.meshy.ai/openapi.yaml — base URL `https://api.meshy.ai/openapi/`.
 */
export class MeshyClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly requestTimeoutMs: number;

  private callCount = 0;

  constructor(options: MeshyClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.meshy.ai/openapi').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.logger ?? createLogger('Meshy');
    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 800;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 8000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
  }

  get calls(): number {
    return this.callCount;
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new GODCPError('MESHY_NOT_CONFIGURED', 'MESHY_API_KEY is not set — cannot call the Meshy API.', {
        stage: 'meshy',
        retryable: false,
      });
    }
    return this.apiKey;
  }

  /** Core request with retry/backoff. Never swallows errors. */
  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    parse?: (data: unknown) => T,
    stage = 'meshy',
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const key = this.requireKey();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.callCount++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let data: unknown;
        try {
          data = text.length > 0 ? JSON.parse(text) : {};
        } catch {
          data = { message: text.slice(0, 500) };
        }
        if (!res.ok) {
          const message =
            (data && typeof data === 'object' && 'message' in data && typeof (data as any).message === 'string'
              ? (data as any).message
              : undefined) ?? res.statusText ?? 'request failed';
          const error = mapHttpError(res.status, message, stage);
          if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxAttempts) {
            lastError = error;
            const delay = this.backoff(attempt);
            this.log.warn(`Meshy ${method} ${path} → ${res.status}, retrying in ${delay}ms`, { attempt });
            await sleep(delay);
            continue;
          }
          throw error;
        }
        return parse ? parse(data) : (data as T);
      } catch (err) {
        if (err instanceof GODCPError) {
          if (err.retryable && attempt < this.maxAttempts) {
            lastError = err;
            const delay = this.backoff(attempt);
            this.log.warn(`Meshy ${method} ${path} failed (${err.code}), retrying in ${delay}ms`, { attempt });
            await sleep(delay);
            continue;
          }
          throw err;
        }
        // Network / abort errors
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const wrapped = isAbort
          ? new GODCPError('TIMEOUT', `Meshy request timed out after ${this.requestTimeoutMs}ms: ${method} ${path}`, {
              stage,
              retryable: true,
              details: { path },
            })
          : new GODCPError('MESHY_UNAVAILABLE', `Meshy request failed: ${err instanceof Error ? err.message : String(err)}`, {
              stage,
              retryable: true,
              details: { path },
            });
        if (attempt < this.maxAttempts) {
          lastError = wrapped;
          const delay = this.backoff(attempt);
          await sleep(delay);
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new GODCPError('MESHY_UNAVAILABLE', 'Meshy request failed after retries', { stage });
  }

  private backoff(attempt: number): number {
    const raw = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * 2 ** (attempt - 1));
    return Math.round(raw * (0.7 + Math.random() * 0.6));
  }

  // ── Text to 3D (v2) ─────────────────────────────────────────────────────

  /** `POST /v2/text-to-3d` with `mode: "preview"` → returns task id. */
  async createTextPreview(spec: MeshyGenerationSpec): Promise<string> {
    const payload: Record<string, unknown> = {
      mode: 'preview',
      prompt: spec.prompt.slice(0, 800),
      name: (spec.name ?? spec.assetId).slice(0, 100),
    };
    if (spec.aiModel) payload.ai_model = spec.aiModel;
    if (spec.targetFormats?.length) payload.target_formats = spec.targetFormats;
    if (spec.targetPolycount) payload.target_polycount = spec.targetPolycount;
    const res = await this.request<{ result: string }>(
      'POST',
      '/v2/text-to-3d',
      payload,
      (d) => parseOrThrow(meshyCreateTaskResponseSchema, d, { stage: 'meshy_generation', label: 'Meshy create text preview' }),
      'meshy_generation',
    );
    this.log.info(`Started text-to-3d preview task for "${spec.assetId}"`, { taskId: res.result });
    return res.result;
  }

  /** `POST /v2/text-to-3d` with `mode: "refine"` → returns task id. */
  async createTextRefine(
    previewTaskId: string,
    spec: Pick<MeshyGenerationSpec, 'assetId' | 'texturePrompt' | 'enablePbr' | 'targetFormats'>,
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      mode: 'refine',
      preview_task_id: previewTaskId,
      name: spec.assetId.slice(0, 100),
    };
    if (spec.texturePrompt) payload.texture_prompt = spec.texturePrompt.slice(0, 800);
    if (spec.enablePbr) payload.enable_pbr = true;
    if (spec.targetFormats?.length) payload.target_formats = spec.targetFormats;
    const res = await this.request<{ result: string }>(
      'POST',
      '/v2/text-to-3d',
      payload,
      (d) => parseOrThrow(meshyCreateTaskResponseSchema, d, { stage: 'meshy_generation', label: 'Meshy create text refine' }),
      'meshy_generation',
    );
    this.log.info(`Started text-to-3d refine task for "${spec.assetId}"`, { taskId: res.result, previewTaskId });
    return res.result;
  }

  /** Fused single-call textured text-to-3D (requires account entitlement). */
  async createTextFused(spec: MeshyGenerationSpec): Promise<string> {
    const payload: Record<string, unknown> = {
      prompt: spec.prompt.slice(0, 800),
      should_texture: true,
      name: (spec.name ?? spec.assetId).slice(0, 100),
    };
    if (spec.texturePrompt) payload.texture_prompt = spec.texturePrompt.slice(0, 800);
    if (spec.aiModel) payload.ai_model = spec.aiModel;
    if (spec.enablePbr) payload.enable_pbr = true;
    if (spec.targetFormats?.length) payload.target_formats = spec.targetFormats;
    const res = await this.request<{ result: string }>(
      'POST',
      '/v2/text-to-3d',
      payload,
      (d) => parseOrThrow(meshyCreateTaskResponseSchema, d, { stage: 'meshy_generation', label: 'Meshy create fused text task' }),
      'meshy_generation',
    );
    this.log.info(`Started fused text-to-3d task for "${spec.assetId}"`, { taskId: res.result });
    return res.result;
  }

  // ── Image to 3D (v1) ────────────────────────────────────────────────────

  /** `POST /v1/image-to-3d` → returns task id. */
  async createImageTo3D(spec: MeshyImageGenerationSpec): Promise<string> {
    const payload: Record<string, unknown> = {
      image_url: spec.imageUrl,
      name: (spec.name ?? spec.assetId).slice(0, 100),
    };
    if (spec.texturePrompt) payload.texture_prompt = spec.texturePrompt.slice(0, 800);
    if (spec.aiModel) payload.ai_model = spec.aiModel;
    if (spec.shouldTexture !== undefined) payload.should_texture = spec.shouldTexture;
    if (spec.enablePbr) payload.enable_pbr = true;
    if (spec.targetFormats?.length) payload.target_formats = spec.targetFormats;
    const res = await this.request<{ result: string }>(
      'POST',
      '/v1/image-to-3d',
      payload,
      (d) => parseOrThrow(meshyCreateTaskResponseSchema, d, { stage: 'meshy_generation', label: 'Meshy create image task' }),
      'meshy_generation',
    );
    this.log.info(`Started image-to-3d task for "${spec.assetId}"`, { taskId: res.result });
    return res.result;
  }

  // ── Task retrieval ──────────────────────────────────────────────────────

  taskPath(id: string, kind: MeshyTaskKind): string {
    return kind === 'text' ? `/v2/text-to-3d/${id}` : `/v1/image-to-3d/${id}`;
  }

  async getTaskRaw(taskId: string, kind: MeshyTaskKind): Promise<MeshyTask> {
    return this.request<MeshyTask>(
      'GET',
      this.taskPath(taskId, kind),
      undefined,
      (d) => parseOrThrow(meshyTaskSchema, d, { stage: 'meshy_status', label: 'Meshy task response' }),
      'meshy_status',
    );
  }

  async getTaskStatus(taskId: string, kind: MeshyTaskKind): Promise<MeshyTaskStatus> {
    const task = await this.getTaskRaw(taskId, kind);
    return normalizeTask(task, kind);
  }

  async listTasks(kind: MeshyTaskKind, pageNum = 1, pageSize = 10): Promise<MeshyTask[]> {
    const path = kind === 'text' ? `/v2/text-to-3d?page_num=${pageNum}&page_size=${pageSize}` : `/v1/image-to-3d?page_num=${pageNum}&page_size=${pageSize}`;
    return this.request<MeshyTask[]>('GET', path, undefined, (d) => {
      if (!Array.isArray(d)) throw new GODCPError('MESHY_UNAVAILABLE', 'Expected an array of tasks', { stage: 'meshy_status' });
      return d.map((t) => parseOrThrow(meshyTaskSchema, t, { stage: 'meshy_status', label: 'Meshy list item' }));
    });
  }

  /** GET /v1/balance — used by `godcp doctor`. Shape is provider-defined; parsed loosely. */
  async getBalance(): Promise<{ ok: true; data: Record<string, unknown> }> {
    const data = await this.request<Record<string, unknown>>('GET', '/v1/balance');
    return { ok: true, data };
  }
}
