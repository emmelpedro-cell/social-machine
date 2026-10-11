import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GoogleEndpoints } from '../../src/main/connectors/youtube/oauth'

type Session = { id: string; total: number; received: Buffer[]; bytes: number; metadata: unknown; done: string | null }

/**
 * A local stand-in for Google's OAuth and YouTube upload endpoints, following
 * the documented behaviour (PKCE check, resumable upload with 308 + Range,
 * status queries), with switches to inject failures.
 */
export class FakeGoogle {
  private server: Server | null = null
  endpoints!: GoogleEndpoints
  readonly sessions = new Map<string, Session>()
  readonly uploadedVideos: { id: string; metadata: unknown; bytes: Buffer; notify: string | null }[] = []
  readonly requests: string[] = []
  /** Code challenge from the last authorization URL the app opened. */
  private challenge: string | null = null
  private validAccessTokens = new Set<string>()
  private tokenCounter = 0

  // Failure switches
  failChunksWith503 = 0
  dropNextChunkConnection = false
  expireNextSessionQuery = false
  refreshFails = false
  rejectAccessTokenOnce = false
  quotaExceeded = false
  channel: { id: string; title: string } | null = { id: 'UC123', title: 'MMA Cortes' }
  revoked: string[] = []

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    this.endpoints = {
      auth: `${base}/auth`,
      token: `${base}/token`,
      revoke: `${base}/revoke`,
      api: `${base}/youtube/v3`,
      upload: `${base}/upload/youtube/v3`
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  /** Simulates the user approving in the browser: follows the auth URL's redirect with a code. */
  approve = async (authUrl: string): Promise<void> => {
    const url = new URL(authUrl)
    this.challenge = url.searchParams.get('code_challenge')
    const redirect = new URL(url.searchParams.get('redirect_uri')!)
    redirect.searchParams.set('code', 'auth-code-1')
    redirect.searchParams.set('state', url.searchParams.get('state')!)
    // Like a browser, don't wait inside openBrowser.
    setTimeout(() => void fetch(redirect).catch(() => undefined), 10)
  }

  deny = async (authUrl: string): Promise<void> => {
    const url = new URL(authUrl)
    const redirect = new URL(url.searchParams.get('redirect_uri')!)
    redirect.searchParams.set('error', 'access_denied')
    redirect.searchParams.set('state', url.searchParams.get('state')!)
    setTimeout(() => void fetch(redirect).catch(() => undefined), 10)
  }

  private newAccessToken(): string {
    const token = `access-${++this.tokenCounter}`
    this.validAccessTokens.add(token)
    return token
  }

  /** Makes every access token issued so far invalid (as if expired early). */
  invalidateAccessTokens(): void {
    this.validAccessTokens.clear()
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
  }

  private authorized(req: IncomingMessage, res: ServerResponse): boolean {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (this.rejectAccessTokenOnce) {
      this.rejectAccessTokenOnce = false
      this.validAccessTokens.delete(token)
    }
    if (!this.validAccessTokens.has(token)) {
      this.json(res, 401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } })
      return false
    }
    return true
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    this.requests.push(`${req.method} ${url.pathname}`)

    // Test hook: the app's stubbed openExternal sends the consent URL here, and we "approve" it.
    if (req.method === 'GET' && url.pathname === '/__approve') {
      await this.approve(url.searchParams.get('url') ?? '')
      res.writeHead(200).end()
      return
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const params = new URLSearchParams((await this.body(req)).toString())
      if (params.get('grant_type') === 'authorization_code') {
        const verifier = params.get('code_verifier') ?? ''
        const expected = createHash('sha256').update(verifier).digest('base64url')
        if (params.get('code') !== 'auth-code-1' || expected !== this.challenge) {
          this.json(res, 400, { error: 'invalid_grant', error_description: 'Bad code or PKCE verifier' })
          return
        }
        this.json(res, 200, { access_token: this.newAccessToken(), refresh_token: 'refresh-1', expires_in: 3599, scope: 'youtube.upload' })
        return
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (this.refreshFails || params.get('refresh_token') !== 'refresh-1') {
          this.json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
          return
        }
        this.json(res, 200, { access_token: this.newAccessToken(), expires_in: 3599 })
        return
      }
    }

    if (req.method === 'POST' && url.pathname === '/revoke') {
      this.revoked.push(new URLSearchParams((await this.body(req)).toString()).get('token') ?? '')
      res.writeHead(200).end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/youtube/v3/channels') {
      if (!this.authorized(req, res)) return
      this.json(res, 200, { items: this.channel ? [{ id: this.channel.id, snippet: { title: this.channel.title } }] : [] })
      return
    }

    if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
      if (!this.authorized(req, res)) return
      if (this.quotaExceeded) {
        this.json(res, 403, { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } })
        return
      }
      const metadata = JSON.parse((await this.body(req)).toString())
      const id = `s${this.sessions.size + 1}`
      const total = Number(req.headers['x-upload-content-length'])
      this.sessions.set(id, { id, total, received: [], bytes: 0, metadata, done: null })
      res.writeHead(200, { Location: `${this.endpoints.upload}/session/${id}?notify=${url.searchParams.get('notifySubscribers')}` }).end()
      return
    }

    const sessionMatch = /^\/upload\/youtube\/v3\/session\/(\w+)$/.exec(url.pathname)
    if (req.method === 'PUT' && sessionMatch) {
      if (!this.authorized(req, res)) return
      const session = this.sessions.get(sessionMatch[1]!)
      const data = await this.body(req)
      if (!session) {
        this.json(res, 404, { error: { code: 404, message: 'Session not found' } })
        return
      }
      const range = String(req.headers['content-range'] ?? '')
      const finish = () => {
        if (!session.done) {
          session.done = `vid-${session.id}`
          this.uploadedVideos.push({ id: session.done, metadata: session.metadata, bytes: Buffer.concat(session.received), notify: url.searchParams.get('notify') })
        }
        this.json(res, 201, { id: session.done, kind: 'youtube#video' })
      }
      const incomplete = () => {
        const headers: Record<string, string> = session.bytes > 0 ? { Range: `bytes=0-${session.bytes - 1}` } : {}
        res.writeHead(308, headers).end()
      }
      if (range.startsWith('bytes */')) {
        if (this.expireNextSessionQuery) {
          this.expireNextSessionQuery = false
          this.sessions.delete(session.id)
          this.json(res, 404, { error: { code: 404, message: 'expired' } })
          return
        }
        if (session.done || session.bytes === session.total) finish()
        else incomplete()
        return
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
      if (!m) {
        this.json(res, 400, { error: { code: 400, message: 'Bad Content-Range' } })
        return
      }
      if (this.dropNextChunkConnection) {
        this.dropNextChunkConnection = false
        req.socket.destroy()
        return
      }
      if (this.failChunksWith503 > 0) {
        this.failChunksWith503--
        this.json(res, 503, { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } })
        return
      }
      const start = Number(m[1])
      if (start !== session.bytes) {
        this.json(res, 400, { error: { code: 400, message: `Expected offset ${session.bytes}, got ${start}` } })
        return
      }
      session.received.push(data)
      session.bytes += data.length
      if (session.bytes === session.total) finish()
      else incomplete()
      return
    }

    res.writeHead(404).end()
  }
}
