import { GODCPError } from '../utils/errors.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Wrap a payload as an MCP tool success result. */
export function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const structured = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : { result: data };
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/** Wrap an error as an MCP tool error result with GODCP structured payload. */
export function fail(err: unknown, stage: string): ToolResult {
  const e = GODCPError.from(err, stage);
  const payload = e.toJSON();
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true,
  };
}

/** Run a tool handler with uniform error handling. */
export async function run<T>(stage: string, fn: () => Promise<T> | T): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err, stage);
  }
}
