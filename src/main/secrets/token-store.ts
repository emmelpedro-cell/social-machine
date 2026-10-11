import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Secrets (OAuth tokens, client secrets) live outside the database, each in
 * its own file encrypted by the operating system (Windows DPAPI through
 * Electron's safeStorage). The database stores only an opaque reference.
 * Secrets are never logged.
 */
export interface SecretStore {
  /** Saves a secret and returns its reference (new or the one given). */
  save(value: unknown, ref?: string): string
  load<T>(ref: string): T | null
  delete(ref: string): void
}

export type Cipher = {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export class SecretUnavailableError extends Error {
  override name = 'SecretUnavailableError'
}

const REF = /^[0-9a-f-]{36}$/

export class FileSecretStore implements SecretStore {
  constructor(
    private readonly directory: string,
    private readonly cipher: Cipher
  ) {}

  private path(ref: string): string {
    if (!REF.test(ref)) throw new Error('Invalid secret reference')
    return join(this.directory, `${ref}.bin`)
  }

  save(value: unknown, ref: string = randomUUID()): string {
    if (!this.cipher.isAvailable()) {
      throw new SecretUnavailableError(
        'O Windows não liberou a criptografia de dados do usuário, então não é possível guardar o login com segurança.'
      )
    }
    mkdirSync(this.directory, { recursive: true })
    const target = this.path(ref)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, this.cipher.encrypt(JSON.stringify(value)))
    renameSync(tmp, target)
    return ref
  }

  load<T>(ref: string): T | null {
    try {
      return JSON.parse(this.cipher.decrypt(readFileSync(this.path(ref)))) as T
    } catch {
      return null
    }
  }

  delete(ref: string): void {
    rmSync(this.path(ref), { force: true })
  }
}

/** For tests: keeps secrets in memory. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>()
  save(value: unknown, ref: string = randomUUID()): string {
    this.values.set(ref, JSON.stringify(value))
    return ref
  }
  load<T>(ref: string): T | null {
    const v = this.values.get(ref)
    return v === undefined ? null : (JSON.parse(v) as T)
  }
  delete(ref: string): void {
    this.values.delete(ref)
  }
}
