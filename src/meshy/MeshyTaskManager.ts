import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { sleep } from '../utils/validation.js';
import type { MeshyGenerationSpec, MeshyImageGenerationSpec } from '../models/AssetSpec.js';
import type { MeshyClient } from './MeshyClient.js';
import {
  DEFAULT_WAIT_OPTIONS,
  type MeshyTaskHandle,
  type MeshyTaskKind,
  type MeshyTaskStatus,
  type TextStrategy,
  type WaitOptions,
} from './MeshyTypes.js';

/**
 * Task lifecycle manager: polling with exponential backoff + jitter, timeout
 * handling, and the documented two-step Text-to-3D (preview → refine) flow.
 */
export class MeshyTaskManager {
  private readonly client: MeshyClient;
  private readonly log: Logger;

  constructor(client: MeshyClient, logger?: Logger) {
    this.client = client;
    this.log = logger ?? createLogger('Meshy:Tasks');
  }

  /** Poll a task until SUCCEEDED / FAILED / CANCELED or timeout. */
  async waitForTask(taskId: string, kind: MeshyTaskKind, options: WaitOptions = {}): Promise<MeshyTaskStatus> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_OPTIONS.timeoutMs;
    let interval = options.initialIntervalMs ?? DEFAULT_WAIT_OPTIONS.initialIntervalMs;
    const maxInterval = options.maxIntervalMs ?? DEFAULT_WAIT_OPTIONS.maxIntervalMs;
    const deadline = Date.now() + timeoutMs;
    let last: MeshyTaskStatus | undefined;

    while (true) {
      if (options.signal?.aborted) {
        throw new GODCPError('CANCELLED', `Polling aborted for task ${taskId}`, { stage: 'meshy_status', retryable: false });
      }
      last = await this.client.getTaskStatus(taskId, kind);
      options.onProgress?.(last.progress, last.status);

      if (last.status === 'SUCCEEDED') {
        this.log.info(`Task ${taskId} succeeded`, { progress: last.progress, credits: last.consumedCredits });
        return last;
      }
      if (last.status === 'FAILED' || last.status === 'CANCELED') {
        const message = last.taskError?.message ?? `task ${last.status.toLowerCase()}`;
        throw new GODCPError('MESHY_TASK_FAILED', `Meshy task ${taskId} ${last.status}: ${message}`, {
          stage: 'meshy_generation',
          retryable: false,
          details: {
            taskId,
            taskError: last.taskError,
            consumedCredits: last.consumedCredits ?? 0,
            canceled: last.status === 'CANCELED',
          },
        });
      }
      if (Date.now() + interval > deadline) {
        throw new GODCPError('MESHY_TASK_TIMEOUT', `Meshy task ${taskId} did not finish within ${timeoutMs}ms (last: ${last.status} ${last.progress}%)`, {
          stage: 'meshy_generation',
          retryable: true,
          details: { taskId, lastStatus: last.status, progress: last.progress },
        });
      }
      const jittered = Math.round(interval * (0.85 + Math.random() * 0.3));
      await sleep(jittered);
      interval = Math.min(maxInterval, Math.round(interval * 1.35));
    }
  }

  /** Full text generation flow according to the chosen strategy. */
  async runTextGeneration(
    spec: MeshyGenerationSpec,
    strategy: TextStrategy = 'two_step',
    options: WaitOptions = {},
  ): Promise<TextGenerationResult> {
    if (strategy === 'fused') {
      const taskId = await this.client.createTextFused(spec);
      const handle: MeshyTaskHandle = { taskId, kind: 'text', assetId: spec.assetId, strategy: 'fused', createdAt: new Date().toISOString() };
      const final = await this.waitForTask(taskId, 'text', options);
      return { handle, final };
    }

    const previewId = await this.client.createTextPreview(spec);
    const previewHandle: MeshyTaskHandle = { taskId: previewId, kind: 'text', assetId: spec.assetId, strategy: 'preview', createdAt: new Date().toISOString() };
    const preview = await this.waitForTask(previewId, 'text', options);
    if (strategy === 'preview_only') return { handle: previewHandle, final: preview };

    const refineId = await this.client.createTextRefine(previewId, spec);
    const refineHandle: MeshyTaskHandle = { taskId: refineId, kind: 'text', assetId: spec.assetId, strategy: 'refine', createdAt: new Date().toISOString() };
    const final = await this.waitForTask(refineId, 'text', options);
    return { handle: refineHandle, final, previewTaskId: previewId };
  }

  /** Create + wait for an image-to-3D task. */
  async runImageGeneration(
    spec: MeshyImageGenerationSpec,
    options: WaitOptions = {},
  ): Promise<TextGenerationResult> {
    const taskId = await this.client.createImageTo3D(spec);
    const handle: MeshyTaskHandle = { taskId, kind: 'image', assetId: spec.assetId, strategy: 'image', createdAt: new Date().toISOString() };
    const final = await this.waitForTask(taskId, 'image', options);
    return { handle, final };
  }
}

export interface TextGenerationResult {
  handle: MeshyTaskHandle;
  final: MeshyTaskStatus;
  previewTaskId?: string;
}
