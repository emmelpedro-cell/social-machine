import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
  child(scope: string): Logger
  readonly filePath: string
}

export type LoggerOptions = {
  directory: string
  fileName?: string
  /** Rotate when the active file exceeds this size. */
  maxBytes?: number
  /** Number of rotated files kept (app.1.log … app.N.log). */
  maxFiles?: number
  minLevel?: LogLevel
  mirrorToConsole?: boolean
  now?: () => Date
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * JSON-lines file logger with size-based rotation. Synchronous writes keep
 * the log intact even if the process crashes right after an error, and the
 * volume in this app is low enough for that to be cheap.
 */
export function createLogger(options: LoggerOptions): Logger {
  const fileName = options.fileName ?? 'app.log'
  const filePath = join(options.directory, fileName)
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 3
  const minLevel = options.minLevel ?? 'info'
  const now = options.now ?? (() => new Date())
  mkdirSync(options.directory, { recursive: true })

  const rotatedPath = (n: number) => join(options.directory, fileName.replace(/\.log$/, '') + `.${n}.log`)

  function rotateIfNeeded(): void {
    if (!existsSync(filePath) || statSync(filePath).size < maxBytes) return
    const oldest = rotatedPath(maxFiles)
    if (existsSync(oldest)) rmSync(oldest)
    for (let n = maxFiles - 1; n >= 1; n--) {
      if (existsSync(rotatedPath(n))) renameSync(rotatedPath(n), rotatedPath(n + 1))
    }
    renameSync(filePath, rotatedPath(1))
  }

  function write(scope: string | undefined, level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[minLevel]) return
    const entry = {
      time: now().toISOString(),
      level,
      ...(scope ? { scope } : {}),
      message,
      ...(context && Object.keys(context).length ? { context: serializable(context) } : {})
    }
    const line = JSON.stringify(entry) + '\n'
    try {
      rotateIfNeeded()
      appendFileSync(filePath, line, 'utf8')
    } catch (error) {
      // Logging must never crash the app.
      console.error('[logger] failed to write log file', error)
    }
    if (options.mirrorToConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(`[${level}]${scope ? ` [${scope}]` : ''} ${message}`, context ?? '')
    }
  }

  function make(scope?: string): Logger {
    return {
      filePath,
      debug: (m, c) => write(scope, 'debug', m, c),
      info: (m, c) => write(scope, 'info', m, c),
      warn: (m, c) => write(scope, 'warn', m, c),
      error: (m, c) => write(scope, 'error', m, c),
      child: (s) => make(scope ? `${scope}:${s}` : s)
    }
  }
  return make()
}

/** Errors don't JSON.stringify usefully; convert them and drop cycles. */
function serializable(value: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>()
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack }
      if (typeof v === 'bigint') return v.toString()
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    })
  ) as Record<string, unknown>
}
