export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'text' | 'json';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  baseScope?: string;
}

export interface Logger {
  scope(scope: string): Logger;
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  readonly level: LogLevel;
  readonly format: LogFormat;
}

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return (raw in LEVEL_ORDER ? raw : 'info') as LogLevel;
}

function envFormat(): LogFormat {
  return (process.env.LOG_FORMAT ?? 'text').toLowerCase() === 'json' ? 'json' : 'text';
}

class ScopedLogger implements Logger {
  readonly level: LogLevel;
  readonly format: LogFormat;
  private readonly scopeName: string;

  constructor(scope: string, level?: LogLevel, format?: LogFormat) {
    this.scopeName = scope;
    this.level = level ?? envLevel();
    this.format = format ?? envFormat();
  }

  scope(scope: string): Logger {
    return new ScopedLogger(this.scopeName ? `${this.scopeName}:${scope}` : scope, this.level, this.format);
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    if (this.format === 'json') {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: this.scopeName || 'GODCP',
        message,
        ...(data ?? {}),
      });
      if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
      return;
    }
    // Text format: [GODCP][Scope] message
    const tag = `[GODCP]${this.scopeName ? `[${this.scopeName}]` : ''}`;
    const extra = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    const line = `${tag} ${message}${extra}`;
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  trace(message: string, data?: Record<string, unknown>): void {
    this.write('trace', message, data);
  }
  debug(message: string, data?: Record<string, unknown>): void {
    this.write('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.write('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.write('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.write('error', message, data);
  }
}

export function createLogger(scope = '', options: LoggerOptions = {}): Logger {
  return new ScopedLogger(scope, options.level, options.format);
}

/** Process-wide root logger. */
export const rootLogger: Logger = createLogger('');
