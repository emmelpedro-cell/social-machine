import { spawn } from 'node:child_process'

export type ProcessErrorCode = 'SPAWN' | 'EXIT' | 'TIMEOUT' | 'ABORTED' | 'OUTPUT_LIMIT'

export class ProcessError extends Error {
  override name = 'ProcessError'
  constructor(
    readonly code: ProcessErrorCode,
    message: string,
    readonly details: { exitCode?: number | null; signal?: string | null; stderr?: string } = {}
  ) {
    super(message)
  }

  /** First meaningful stderr line, for user-facing messages. */
  get stderrSummary(): string {
    const lines = (this.details.stderr ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return lines.find((l) => /error|invalid|failed|not found|unsupported/i.test(l)) ?? lines.at(-1) ?? ''
  }
}

export type RunOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** stdout beyond this is an error (protects memory from runaway output). */
  maxStdoutBytes?: number
  /** Only the tail of stderr is kept, for diagnostics. */
  maxStderrBytes?: number
  cwd?: string
}

export type RunResult = { stdout: string; stderr: string }

/**
 * Runs a program asynchronously without a shell. Arguments are passed as an
 * array, so file names are never interpreted by a shell. The child is killed
 * on abort or timeout. Never blocks the event loop.
 */
export function runProcess(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { signal, timeoutMs = 60_000, maxStdoutBytes = 16 * 1024 * 1024, maxStderrBytes = 64 * 1024 } = options

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProcessError('ABORTED', 'Cancelled'))
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(new ProcessError('SPAWN', (error as Error).message))
      return
    }

    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let failure: ProcessError | null = null

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const kill = (reason: ProcessError) => {
      if (failure) return
      failure = reason
      child.kill()
      // Give the process a moment to exit; force it if it ignores the request.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 2000).unref()
    }

    const onAbort = () => kill(new ProcessError('ABORTED', 'Cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(
      () => kill(new ProcessError('TIMEOUT', `Timed out after ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs
    )

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxStdoutBytes) {
        kill(new ProcessError('OUTPUT_LIMIT', 'The program produced more output than expected'))
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > maxStderrBytes) stderr = stderr.slice(-maxStderrBytes)
    })

    child.on('error', (error) => {
      finish(() => reject(new ProcessError('SPAWN', error.message, { stderr })))
    })

    child.on('close', (exitCode, signalCode) => {
      finish(() => {
        if (failure) {
          reject(new ProcessError(failure.code, failure.message, { exitCode, signal: signalCode, stderr }))
        } else if (exitCode !== 0) {
          reject(
            new ProcessError('EXIT', `Exited with code ${exitCode ?? signalCode}`, {
              exitCode,
              signal: signalCode,
              stderr
            })
          )
        } else {
          resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr })
        }
      })
    })
  })
}
