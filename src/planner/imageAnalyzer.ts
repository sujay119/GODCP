import type { ReferenceAnalysis } from '../models/ScenePlan.js';
import type { ReferenceAnalyzer } from '../vision/ReferenceAnalyzer.js';

/**
 * Planner-side bridge to vision: converts a reference image into a validated
 * ReferenceAnalysis (delegates the actual analysis to the vision layer).
 */
export async function analyzeReferenceImage(
  analyzer: ReferenceAnalyzer,
  imagePath: string,
  hints?: string[],
): Promise<ReferenceAnalysis> {
  return analyzer.analyze(imagePath, hints);
}
