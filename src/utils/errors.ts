export type GODCPErrorCode =
  // config / generic
  | 'CONFIG_INVALID'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'BUDGET_EXCEEDED'
  | 'APPROVAL_REQUIRED'
  | 'DRY_RUN_BLOCKED'
  | 'INTERNAL_ERROR'
  // reference / vision
  | 'VISION_INVALID_IMAGE'
  | 'VISION_PROVIDER_FAILED'
  | 'VISION_UNAVAILABLE'
  // planning
  | 'PLAN_VALIDATION_FAILED'
  | 'MANIFEST_INVALID'
  | 'PLAN_MISSING'
  | 'MANIFEST_MISSING'
  // meshy
  | 'MESHY_AUTH_INVALID'
  | 'MESHY_RATE_LIMIT'
  | 'MESHY_INSUFFICIENT_CREDITS'
  | 'MESHY_BAD_REQUEST'
  | 'MESHY_UNAVAILABLE'
  | 'MESHY_TASK_FAILED'
  | 'MESHY_TASK_TIMEOUT'
  | 'MESHY_DOWNLOAD_FAILED'
  | 'MESHY_NOT_CONFIGURED'
  // unity
  | 'UNITY_UNAVAILABLE'
  | 'UNITY_MCP_UNAVAILABLE'
  | 'UNITY_TOOL_UNAVAILABLE'
  | 'UNITY_RENDER_UNAVAILABLE'
  | 'UNITY_SCENE_SAVE_FAILED'
  | 'UNITY_IMPORT_FAILED'
  | 'UNITY_OPERATION_FAILED'
  // registry / state
  | 'REGISTRY_FAILED'
  | 'STATE_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'REPORT_MISSING';

export interface GODCPErrorDetails {
  [key: string]: unknown;
}

export interface StructuredErrorPayload {
  success: false;
  stage: string;
  errorCode: GODCPErrorCode;
  message: string;
  retryable: boolean;
  details?: GODCPErrorDetails;
}

export class GODCPError extends Error {
  readonly code: GODCPErrorCode;
  readonly stage: string;
  readonly retryable: boolean;
  readonly details?: GODCPErrorDetails;

  constructor(
    code: GODCPErrorCode,
    message: string,
    options: { stage?: string; retryable?: boolean; details?: GODCPErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'GODCPError';
    this.code = code;
    this.stage = options.stage ?? 'unknown';
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): StructuredErrorPayload {
    const payload: StructuredErrorPayload = {
      success: false,
      stage: this.stage,
      errorCode: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details) payload.details = this.details;
    return payload;
  }

  static from(err: unknown, stage: string, fallbackCode: GODCPErrorCode = 'INTERNAL_ERROR'): GODCPError {
    if (err instanceof GODCPError) {
      if (err.stage === stage) return err;
      return new GODCPError(err.code, err.message, {
        stage,
        retryable: err.retryable,
        details: err.details,
        cause: err,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new GODCPError(fallbackCode, message, { stage, cause: err });
  }
}

export function isGODCPError(err: unknown): err is GODCPError {
  return err instanceof GODCPError;
}

/** Normalize any thrown value into the structured MCP/CLI error payload. */
export function toStructuredError(err: unknown, stage: string): StructuredErrorPayload {
  return GODCPError.from(err, stage).toJSON();
}
