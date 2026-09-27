import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppContext, analyzer, comparator,  } from './context.js';
import { run } from './toolHelpers.js';

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    'godcp_analyze_reference',
    {
      title: 'Analyze reference environment image',
      description:
        'Analyze a reference environment image and return a structured ReferenceAnalysis: colors, layout/regions, lighting/time-of-day, atmosphere, detected object classes, and confidence scores. Heuristic provider works offline (PNG); set VISION_PROVIDER=openai for VLM analysis.',
      inputSchema: {
        referenceImage: z.string().describe('Absolute or workspace-relative path to the reference image (PNG preferred).'),
        hints: z.array(z.string()).optional().describe('Optional freeform hints (e.g. "target style: cyberpunk").'),
      },
    },
    async ({ referenceImage, hints }) =>
      run('vision', async () => {
        const ctx = getAppContext();
        const analysis = await analyzer(ctx).analyze(referenceImage, hints);
        return { analysis, visionProvider: ctx.config.vision.provider };
      }),
  );

  server.registerTool(
    'godcp_compare_images',
    {
      title: 'Compare render against reference',
      description:
        'Compare a render against the reference image and return a ComparisonResult: overallSimilarity (0..1), per-dimension scores, detected differences, and suggested corrections.',
      inputSchema: {
        referenceImage: z.string().describe('Path to the reference image.'),
        renderImage: z.string().describe('Path to the render to compare.'),
        similarityTarget: z.number().min(0).max(1).optional().describe('Target similarity used to bias suggestions.'),
      },
    },
    async ({ referenceImage, renderImage, similarityTarget }) =>
      run('comparison', async () => {
        const ctx = getAppContext();
        const comparison = await comparator(ctx).compare(referenceImage, renderImage, { similarityTarget });
        return comparison;
      }),
  );
}
