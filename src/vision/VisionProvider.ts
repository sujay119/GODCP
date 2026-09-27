import type { ComparisonResult } from '../models/ComparisonResult.js';
import type { ReferenceAnalysis } from '../models/ScenePlan.js';

export interface AnalyzeImageInput {
  imagePath: string;
  /** Optional hints from the caller (e.g. target project context). */
  hints?: string[];
}

export interface CompareImagesInput {
  referenceImagePath: string;
  renderImagePath: string;
  /** Optional scene context to ground the comparison (objects, names). */
  context?: {
    sceneName?: string;
    objectNames?: string[];
    similarityTarget?: number;
  };
}

/**
 * Vision provider abstraction. Implementations: heuristic (offline, PNG pixel
 * analysis) and openai (any OpenAI-compatible chat-completions endpoint with
 * image input). Future: local vision models, other vendors.
 */
export interface VisionProvider {
  readonly providerId: string;
  readonly supportsComparison: boolean;
  analyzeImage(input: AnalyzeImageInput): Promise<ReferenceAnalysis>;
  compareImages(input: CompareImagesInput): Promise<ComparisonResult>;
}
