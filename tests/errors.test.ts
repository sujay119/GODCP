import { describe, expect, it } from 'vitest';
import { GODCPError, toStructuredError, isGODCPError } from '../src/utils/errors.js';

describe('GODCPError', () => {
  it('builds a structured envelope', () => {
    const e = new GODCPError('MESHY_AUTH_INVALID', 'bad key', { stage: 'meshy', retryable: false, details: { status: 401 } });
    const json = e.toJSON();
    expect(json).toEqual({
      success: false,
      stage: 'meshy',
      errorCode: 'MESHY_AUTH_INVALID',
      message: 'bad key',
      retryable: false,
      details: { status: 401 },
    });
  });

  it('GODCPError.from preserves code and restages', () => {
    const orig = new GODCPError('BUDGET_EXCEEDED', 'over budget', { stage: 'asset_generation', retryable: true });
    const staged = GODCPError.from(orig, 'build');
    expect(staged.code).toBe('BUDGET_EXCEEDED');
    expect(staged.stage).toBe('build');
    expect(staged.retryable).toBe(true);
  });

  it('GODCPError.from wraps plain errors with fallback code', () => {
    const e = GODCPError.from(new Error('boom'), 'render', 'UNITY_RENDER_UNAVAILABLE');
    expect(e.code).toBe('UNITY_RENDER_UNAVAILABLE');
    expect(e.message).toBe('boom');
  });

  it('toStructuredError produces the MCP error payload', () => {
    const payload = toStructuredError('oops', 'vision');
    expect(payload.success).toBe(false);
    expect(payload.errorCode).toBe('INTERNAL_ERROR');
    expect(payload.stage).toBe('vision');
  });

  it('isGODCPError narrows', () => {
    expect(isGODCPError(new GODCPError('NOT_FOUND', 'x'))).toBe(true);
    expect(isGODCPError(new Error('x'))).toBe(false);
  });
});
