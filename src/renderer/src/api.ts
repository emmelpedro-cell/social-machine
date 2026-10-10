import type { IpcErrorCode, IpcResult } from '../../shared/schemas'

export class ApiError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Turns an IPC result into a value or a thrown ApiError with a user-readable message. */
export async function unwrap<T>(pending: Promise<IpcResult<T>>): Promise<T> {
  const result = await pending
  if (result.ok) return result.data
  throw new ApiError(result.error.code, result.error.message)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export const api = window.sm

/** Forward uncaught renderer errors to the main-process log file. */
export function installRendererErrorLogging(): void {
  window.addEventListener('error', (event) => {
    void api.log.write({
      level: 'error',
      message: `Renderer error: ${event.message}`,
      context: { source: event.filename, line: event.lineno, column: event.colno }
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    void api.log.write({
      level: 'error',
      message: `Unhandled rejection in renderer: ${errorMessage(event.reason)}`
    })
  })
}
