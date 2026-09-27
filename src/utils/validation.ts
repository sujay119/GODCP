import type { ZodTypeAny, z } from 'zod';
import { GODCPError, type GODCPErrorCode } from './errors.js';

/**
 * Parse `data` with `schema`, throwing a structured GODCPError on failure.
 * Used at every trust boundary (MCP tool inputs, API responses, persisted state).
 */
export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  options: { stage: string; code?: GODCPErrorCode; label?: string },
): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const label = options.label ? `${options.label}: ` : '';
  throw new GODCPError(options.code ?? 'VALIDATION_FAILED', `${label}${result.error.issues[0]?.message ?? 'validation failed'}`, {
    stage: options.stage,
    retryable: false,
    details: { issues },
  });
}

/** Non-throwing variant. */
export function tryParse<S extends ZodTypeAny>(schema: S, data: unknown): { ok: true; value: z.output<S> } | { ok: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.message };
}

export function assertNonEmpty(value: string | undefined | null, field: string, stage: string): string {
  if (!value || value.trim().length === 0) {
    throw new GODCPError('VALIDATION_FAILED', `${field} must be a non-empty string`, {
      stage,
      details: { field },
    });
  }
  return value;
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
