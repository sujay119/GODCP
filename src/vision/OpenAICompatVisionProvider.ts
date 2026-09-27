import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { GODCPError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { sleep } from '../utils/validation.js';
import { referenceAnalysisSchema, type ReferenceAnalysis } from '../models/ScenePlan.js';
import { comparisonResultSchema, type ComparisonResult } from '../models/ComparisonResult.js';
import type { AnalyzeImageInput, CompareImagesInput, VisionProvider } from './VisionProvider.js';

export interface OpenAICompatVisionOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  maxAttempts?: number;
  timeoutMs?: number;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * Vision provider backed by any OpenAI-compatible chat-completions endpoint
 * with image input (OpenAI, Azure OpenAI, local gateways, etc.).
 */
export class OpenAICompatVisionProvider implements VisionProvider {
  readonly providerId = 'openai';
  readonly supportsComparison = true;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatVisionOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = options.model ?? 'gpt-4o-mini';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.logger ?? createLogger('Vision:OpenAI');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 120000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<ReferenceAnalysis> {
    const prompt = `You are analyzing a reference image of an environment for a 3D scene reconstruction pipeline.
Return STRICT JSON with this shape (no markdown, no commentary):
{
  "environmentType": string,
  "visualStyle": string,
  "composition": {"cameraPosition": {x,y,z}, "cameraDirection": {x,y,z}, "estimatedFov": number, "confidence": 0..1},
  "geometry": {"terrain": "flat|sloped|uneven|hilly|water|unknown", "road": bool, "sidewalk": bool, "buildings": bool, "vegetation": bool, "water": bool, "vehicles": bool, "bridge": bool},
  "objects": [{"name": slug, "type": string, "importance": 0..1, "confidence": 0..1, "estimatedPosition": {x,y,z}, "estimatedScale": {x,y,z}, "notes": string}],
  "lighting": {"timeOfDay": string, "direction": {x,y,z}, "intensityHint": "dim|normal|bright", "shadows": bool, "confidence": 0..1},
  "colors": {"dominant": ["#hex"], "accent": ["#hex"], "averageHex": "#hex"},
  "materials": [{"name": string, "kind": string, "confidence": 0..1}],
  "atmosphere": {"fog": bool, "haze": bool, "weather": string, "mood": string},
  "compositionNotes": [string],
  "confidence": 0..1,
  "warnings": [string]
}
Rules: cameraPosition y ≈ human eye height unless clearly aerial; cameraDirection normalized, usually z=-1; never fabricate certainty — set confidence honestly; list the most visually important objects (max 12).
${input.hints?.length ? `Additional context: ${input.hints.join('; ')}` : ''}`;

    const data = await this.chat([
      { role: 'system', content: 'You output only valid JSON matching the requested schema.' },
      { role: 'user', content: [{ type: 'text', text: prompt }, await this.imagePart(input.imagePath)] },
    ]);

    const parsed = referenceAnalysisSchema.safeParse(stripJsonFence(data));
    if (!parsed.success) {
      // Fill required fields with safe defaults if the model omitted them
      const merged = referenceAnalysisSchema.safeParse({
        sourceImage: input.imagePath,
        environmentType: (data as any)?.environmentType ?? 'unknown',
        visualStyle: (data as any)?.visualStyle ?? 'realistic',
        composition: (data as any)?.composition ?? { cameraPosition: { x: 0, y: 1.7, z: 8 }, cameraDirection: { x: 0, y: 0, z: -1 }, estimatedFov: 50, confidence: 0.5 },
        geometry: (data as any)?.geometry ?? {},
        objects: (data as any)?.objects ?? [],
        lighting: (data as any)?.lighting ?? {},
        colors: (data as any)?.colors ?? {},
        materials: (data as any)?.materials ?? [],
        atmosphere: (data as any)?.atmosphere ?? {},
        compositionNotes: (data as any)?.compositionNotes ?? [],
        confidence: typeof (data as any)?.confidence === 'number' ? (data as any).confidence : 0.6,
        warnings: (data as any)?.warnings ?? [],
        sourceImageOverride: input.imagePath,
      });
      if (merged.success) {
        merged.data.sourceImage = input.imagePath;
        return merged.data;
      }
      throw new GODCPError('VISION_PROVIDER_FAILED', `Vision model returned an invalid analysis: ${parsed.error.issues[0]?.message}`, {
        stage: 'vision',
        details: { issues: parsed.error.issues.slice(0, 5) },
      });
    }
    parsed.data.sourceImage = input.imagePath;
    return parsed.data;
  }

  async compareImages(input: CompareImagesInput): Promise<ComparisonResult> {
    const prompt = `Compare these two images. Image 1 is the REFERENCE (target look). Image 2 is a RENDER of a Unity scene that must match the reference.
Return STRICT JSON only:
{
  "overallSimilarity": 0..1,
  "differences": [{"type": "camera|placement|scale|missing_object|extra_object|color|lighting|composition|perspective|terrain|proportions|material|other", "object": string?, "description": string, "expected": string?, "observed": string?, "confidence": 0..1, "severity": "low|medium|high"}],
  "corrections": [{"action": "move|rotate|scale|add_object|remove_object|recolor|relight|recamera|adjust_terrain|adjust_material|adjust_fog", "target": string, "params": object, "rationale": string, "confidence": 0..1}],
  "summary": string,
  "warnings": [string]
}
Rules: corrections must be concrete and applicable (numbers in params: e.g. {"factor": 1.3}, {"position": {x,y,z}}, {"intensityFactor": 1.2}); prioritize high-impact fixes; max 12 differences, max 10 corrections.
${input.context?.objectNames?.length ? `Scene objects: ${input.context.objectNames.join(', ')}` : ''}`;

    const data = await this.chat([
      { role: 'system', content: 'You output only valid JSON matching the requested schema.' },
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'text', text: 'REFERENCE IMAGE:' },
        await this.imagePart(input.referenceImagePath),
        { type: 'text', text: 'RENDER IMAGE:' },
        await this.imagePart(input.renderImagePath),
      ] },
    ]);

    const parsed = comparisonResultSchema.safeParse({ ...(data as object), method: 'vision_llm' });
    if (!parsed.success) {
      throw new GODCPError('VISION_PROVIDER_FAILED', `Vision model returned an invalid comparison: ${parsed.error.issues[0]?.message}`, {
        stage: 'comparison',
        details: { issues: parsed.error.issues.slice(0, 5) },
      });
    }
    parsed.data.method = 'vision_llm';
    return parsed.data;
  }

  private async imagePart(path: string): Promise<{ type: 'image_url'; image_url: { url: string } }> {
    const ext = extname(path).toLowerCase();
    const mime = MIME[ext] ?? 'image/png';
    const buf = await readFile(path);
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } };
  }

  private async chat(messages: unknown[]): Promise<unknown> {
    if (!this.apiKey) {
      throw new GODCPError('VISION_UNAVAILABLE', 'VISION_API_KEY is not set for the openai vision provider.', { stage: 'vision' });
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, messages, temperature: 0.2, response_format: { type: 'json_object' } }),
          signal: controller.signal,
        });
        const body = (await res.json()) as any;
        if (!res.ok) {
          const message = body?.error?.message ?? res.statusText;
          const retryable = res.status === 429 || res.status >= 500;
          const err = new GODCPError('VISION_PROVIDER_FAILED', `Vision API error ${res.status}: ${message}`, { stage: 'vision', retryable });
          if (retryable && attempt < this.maxAttempts) {
            lastErr = err;
            await sleep(800 * attempt);
            continue;
          }
          throw err;
        }
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new GODCPError('VISION_PROVIDER_FAILED', 'Vision API returned no content.', { stage: 'vision' });
        }
        return JSON.parse(stripJsonFence(content) as string);
      } catch (err) {
        if (err instanceof GODCPError) {
          if (err.retryable && attempt < this.maxAttempts) {
            lastErr = err;
            await sleep(800 * attempt);
            continue;
          }
          throw err;
        }
        const wrapped = err instanceof Error && err.name === 'AbortError'
          ? new GODCPError('TIMEOUT', `Vision API timed out after ${this.timeoutMs}ms`, { stage: 'vision', retryable: true })
          : GODCPError.from(err, 'vision', 'VISION_PROVIDER_FAILED');
        if (attempt < this.maxAttempts) {
          lastErr = wrapped;
          await sleep(800 * attempt);
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new GODCPError('VISION_PROVIDER_FAILED', 'Vision request failed', { stage: 'vision' });
  }
}

function stripJsonFence(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    return content;
  }
}

export const _zodGuards = { z };
