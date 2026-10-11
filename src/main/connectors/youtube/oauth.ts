import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * OAuth 2.0 for installed apps, as Google documents it for desktop clients:
 * the system browser opens Google's consent page, Google redirects to a
 * loopback address (http://127.0.0.1:<random port>) served by the app, and
 * the code is exchanged with PKCE (S256). The app never sees the password.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type GoogleEndpoints = {
  auth: string
  token: string
  revoke: string
  api: string
  upload: string
  /** YouTube Analytics API v2 (watch time, shares, subscribers gained). */
  analytics: string
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3',
  analytics: 'https://youtubeanalytics.googleapis.com/v2'
}

/** Upload videos; read the channel, video statistics and YouTube Analytics reports (which accept `youtube.readonly`). */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']

export type OAuthClient = { clientId: string; clientSecret: string }

export type StoredTokens = {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms. */
  expiresAt: number
  scope: string
}

export class OAuthError extends Error {
  override name = 'OAuthError'
  constructor(
    message: string,
    /** True when the grant is gone (revoked, expired): the user must connect again. */
    readonly reauthorize = false
  ) {
    super(message)
  }
}

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

const DONE_PAGE = (ok: boolean, message: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Social Machine</title><style>body{font:16px system-ui,sans-serif;background:#0e1014;color:#ecebe7;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:420px;text-align:center}h1{font-size:20px;color:${ok ? '#4fb38a' : '#e2604a'}}</style></head>
<body><main><h1>${ok ? 'Conta conectada' : 'Não foi possível conectar'}</h1><p>${message}</p></main></body></html>`

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

async function tokenRequest(fetch: Fetch, url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    })
  } catch (error) {
    throw new OAuthError(`Sem conexão com o Google (${(error as Error).message}).`)
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const code = String(body['error'] ?? response.status)
    if (code === 'invalid_grant') {
      throw new OAuthError('O acesso à conta expirou ou foi revogado. Conecte a conta de novo.', true)
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') {
      throw new OAuthError('O Google recusou o Client ID/Secret configurado. Confira as credenciais em Contas → YouTube.')
    }
    throw new OAuthError(`O Google recusou o pedido (${code}${body['error_description'] ? `: ${String(body['error_description'])}` : ''}).`)
  }
  return body
}

function toTokens(body: Record<string, unknown>, previousRefresh: string | null, now: number): StoredTokens {
  const accessToken = body['access_token']
  if (typeof accessToken !== 'string') throw new OAuthError('O Google não devolveu um token de acesso.')
  const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600
  return {
    accessToken,
    refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : previousRefresh,
    expiresAt: now + expiresIn * 1000,
    scope: typeof body['scope'] === 'string' ? body['scope'] : ''
  }
}

/**
 * Runs the consent flow. Resolves with tokens once the user approved in the
 * browser; rejects if they denied, closed it (timeout) or the state didn't match.
 */
export async function authorizeWithLoopback(options: {
  client: OAuthClient
  scopes: string[]
  openBrowser: (url: string) => Promise<void> | void
  fetch: Fetch
  endpoints?: GoogleEndpoints
  timeoutMs?: number
  signal?: AbortSignal
  now?: () => number
}): Promise<StoredTokens> {
  const endpoints = options.endpoints ?? GOOGLE_ENDPOINTS
  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(24))
  let server: Server | null = null

  try {
    const result = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = ''
      const timer = setTimeout(
        () => reject(new OAuthError('O tempo para autorizar no navegador acabou. Tente conectar de novo.')),
        options.timeoutMs ?? 5 * 60_000
      )
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      options.signal?.addEventListener('abort', () => fail(new OAuthError('Conexão cancelada.')), { once: true })

      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        const respond = (ok: boolean, message: string) => {
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(ok, escapeHtml(message)))
        }
        if (returnedState !== state) {
          respond(false, 'A resposta não corresponde a este pedido. Volte ao app e tente de novo.')
          return // ignore stray requests; keep waiting for the real redirect
        }
        if (error) {
          respond(false, error === 'access_denied' ? 'Você não autorizou o acesso.' : `O Google respondeu: ${error}.`)
          fail(new OAuthError(error === 'access_denied' ? 'Você não autorizou o acesso à conta.' : `Autorização recusada (${error}).`))
          return
        }
        if (!code) {
          respond(false, 'O Google não enviou o código de autorização.')
          fail(new OAuthError('O Google não enviou o código de autorização.'))
          return
        }
        respond(true, 'Pode fechar esta aba e voltar para a Social Machine.')
        clearTimeout(timer)
        resolve({ code, redirectUri })
      })
      server.on('error', (e) => fail(new OAuthError(`Não foi possível abrir a porta local para o login (${e.message}).`)))
      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port
        redirectUri = `http://127.0.0.1:${port}`
        const auth = new URL(endpoints.auth)
        auth.search = new URLSearchParams({
          client_id: options.client.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: options.scopes.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          // Always show consent so Google returns a refresh token, also when reconnecting.
          prompt: 'consent select_account'
        }).toString()
        Promise.resolve(options.openBrowser(auth.toString())).catch((e: Error) =>
          fail(new OAuthError(`Não foi possível abrir o navegador (${e.message}).`))
        )
      })
    })

    const params: Record<string, string> = {
      code: result.code,
      client_id: options.client.clientId,
      redirect_uri: result.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    }
    if (options.client.clientSecret) params['client_secret'] = options.client.clientSecret
    const body = await tokenRequest(options.fetch, endpoints.token, params)
    return toTokens(body, null, (options.now ?? Date.now)())
  } finally {
    ;(server as Server | null)?.close()
  }
}

export async function refreshTokens(options: {
  client: OAuthClient
  tokens: StoredTokens
  fetch: Fetch
  endpoints?: GoogleEndpoints
  now?: () => number
}): Promise<StoredTokens> {
  if (!options.tokens.refreshToken) throw new OAuthError('O login não tem renovação automática. Conecte a conta de novo.', true)
  const params: Record<string, string> = {
    client_id: options.client.clientId,
    refresh_token: options.tokens.refreshToken,
    grant_type: 'refresh_token'
  }
  if (options.client.clientSecret) params['client_secret'] = options.client.clientSecret
  const body = await tokenRequest(options.fetch, (options.endpoints ?? GOOGLE_ENDPOINTS).token, params)
  return toTokens(body, options.tokens.refreshToken, (options.now ?? Date.now)())
}

/** Best effort: tells Google to drop the grant. Local data is deleted regardless. */
export async function revokeTokens(fetch: Fetch, tokens: StoredTokens, endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS): Promise<void> {
  const token = tokens.refreshToken ?? tokens.accessToken
  await fetch(endpoints.revoke, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString()
  }).catch(() => undefined)
}
