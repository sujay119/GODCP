import type { GeneratedAsset, MeshyGenerationSpec, MeshyImageGenerationSpec } from '../models/AssetSpec.js';
import type { MeshyTaskHandle, MeshyTaskKind, MeshyTaskStatus, TextStrategy, WaitOptions } from './MeshyTypes.js';

/**
 * Provider abstraction for 3D asset generation. Meshy is the built-in
 * implementation; future providers (local models, other vendors) implement this
 * interface and plug into the orchestration layer unchanged.
 */
export interface AssetGenerationProvider {
  readonly providerId: string;

  /** True when credentials/config allow real generation. */
  isConfigured(): boolean;

  /** Start a text-to-3D task (does not wait for completion). */
  generateFromText(spec: MeshyGenerationSpec): Promise<MeshyTaskHandle>;

  /** Start an image-to-3D task (does not wait for completion). */
  generateFromImage(spec: MeshyImageGenerationSpec): Promise<MeshyTaskHandle>;

  /** Fetch current status of a task. */
  getTask(taskId: string, kind: MeshyTaskKind): Promise<MeshyTaskStatus>;

  /** Poll until terminal status / timeout. */
  waitForTask(taskId: string, kind: MeshyTaskKind, options?: WaitOptions): Promise<MeshyTaskStatus>;

  /**
   * Convenience: run the full text generation flow (preview→refine, fused, or
   * preview-only) and return the final terminal status.
   */
  completeTextGeneration(spec: MeshyGenerationSpec, strategy?: TextStrategy, options?: WaitOptions): Promise<MeshyTaskStatus>;

  /** Convenience: create + wait for an image-to-3D task. */
  completeImageGeneration(spec: MeshyImageGenerationSpec, options?: WaitOptions): Promise<MeshyTaskStatus>;

  /** Download model + textures of a SUCCEEDED task into `destination`. */
  downloadAsset(status: MeshyTaskStatus, destination: string): Promise<GeneratedAsset>;

  /**
   * End-to-end helper: generate (text or image) → wait → download into
   * `destination`. Implementations should consult their cache first.
   */
  generateAndDownload(
    spec: MeshyGenerationSpec | MeshyImageGenerationSpec,
    destination: string,
    options?: { strategy?: TextStrategy; wait?: WaitOptions },
  ): Promise<GeneratedAsset>;

  /** Usage counters for budgeting/reporting. */
  stats(): { callCount: number; generationsStarted: number; creditsSpent: number };
}
