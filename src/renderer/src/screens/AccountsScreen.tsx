import { useEffect, useState } from 'react'
import type { Account, PlatformId } from '../../../shared/publishing'
import type { Project } from '../../../shared/schemas'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'
import { useAccounts } from '../publishing/usePublishing'

type Props = {
  projects: Project[]
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

const STATUS_LABEL: Record<Account['connectionStatus'], string> = {
  connected: 'Conectada',
  disconnected: 'Desconectada',
  expired: 'Login expirado',
  error: 'Com erro'
}

export function AccountsScreen({ projects, onNotice, onError }: Props) {
  const { accounts, platforms, reload } = useAccounts()
  const [clientId, setClientId] = useState<string | null>(null)
  const [editingCredentials, setEditingCredentials] = useState(false)
  const [newClientId, setNewClientId] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [manualName, setManualName] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<string | null>(null)

  const youtubeInfo = platforms?.find((p) => p.id === 'youtube')

  useEffect(() => {
    unwrap(api.youtube.credentials()).then((c) => setClientId(c.clientId), onError)
  }, [onError])

  async function saveCredentials() {
    try {
      await unwrap(api.youtube.setCredentials(newClientId.trim(), newSecret.trim()))
      setClientId(newClientId.trim())
      setNewSecret('')
      setEditingCredentials(false)
      await reload()
      onNotice({ tone: 'success', text: 'Credenciais do YouTube salvas. Agora conecte o canal.' })
    } catch (e) {
      onError(e)
    }
  }

  async function connectYouTube() {
    setConnecting(true)
    try {
      const account = await unwrap(api.accounts.connectYouTube([]))
      await reload()
      onNotice({ tone: 'success', text: `Canal “${account.displayName}” conectado.` })
    } catch (e) {
      onError(e)
    } finally {
      setConnecting(false)
    }
  }

  async function addManual(platformId: PlatformId) {
    const name = (manualName[platformId] ?? '').trim()
    if (!name) {
      onNotice({ tone: 'error', text: 'Dê um nome à conta (por exemplo, o @ do perfil).' })
      return
    }
    try {
      await unwrap(api.accounts.addManual(platformId, name, []))
      setManualName((m) => ({ ...m, [platformId]: '' }))
      await reload()
    } catch (e) {
      onError(e)
    }
  }

  async function toggleProject(account: Account, projectId: string) {
    const projectIds = account.projectIds.includes(projectId)
      ? account.projectIds.filter((id) => id !== projectId)
      : [...account.projectIds, projectId]
    try {
      await unwrap(api.accounts.update(account.id, { projectIds }))
      await reload()
    } catch (e) {
      onError(e)
    }
  }

  async function disconnect(account: Account) {
    try {
      await unwrap(api.accounts.disconnect(account.id))
      setConfirm(null)
      await reload()
      onNotice({ tone: 'info', text: `${account.displayName} desconectada. O histórico de publicações foi mantido.` })
    } catch (e) {
      onError(e)
    }
  }

  async function remove(account: Account) {
    try {
      await unwrap(api.accounts.remove(account.id))
      setConfirm(null)
      await reload()
    } catch (e) {
      onError(e)
    }
  }

  const byPlatform = (id: PlatformId) => (accounts ?? []).filter((a) => a.platformId === id)

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Destinos de publicação</p>
          <h1>Contas</h1>
        </div>
      </header>

      {/* YouTube */}
      <section className="panel" data-testid="platform-youtube">
        <div className="panel-head">
          <h2>
            <span className="platform-badge pf-youtube">YouTube</span> Envio pela API oficial
          </h2>
        </div>
        <p className="muted small">{youtubeInfo?.note}</p>

        {(!clientId || editingCredentials) && (
          <div className="setup-guide" data-testid="youtube-setup">
            <h3>Configurar uma vez</h3>
            <ol className="small">
              <li>
                Em <strong>console.cloud.google.com</strong>, crie um projeto e ative a <strong>YouTube Data API v3</strong>.
              </li>
              <li>
                Em “Tela de consentimento OAuth”, escolha <strong>Externo</strong>, adicione seu e-mail como <strong>usuário de teste</strong> e os
                escopos <code>youtube.upload</code> e <code>youtube.readonly</code>.
              </li>
              <li>
                Em “Credenciais”, crie um <strong>ID do cliente OAuth</strong> do tipo <strong>App para computador</strong> e copie o Client ID e a
                chave secreta.
              </li>
              <li>
                Em modo “Teste”, o Google expira o login a cada 7 dias: reconecte quando a conta aparecer como “Login expirado”. Publicar o app
                (“Em produção”) evita isso, mas o Google mostra um aviso de app não verificado.
              </li>
            </ol>
            <div className="credentials-form">
              <input value={newClientId} onChange={(e) => setNewClientId(e.target.value)} placeholder="…apps.googleusercontent.com" aria-label="Client ID" data-testid="youtube-client-id" />
              <input value={newSecret} onChange={(e) => setNewSecret(e.target.value)} placeholder="Chave secreta do cliente (GOCSPX-…)" type="password" aria-label="Chave secreta" data-testid="youtube-client-secret" />
              <div className="row">
                <button type="button" className="btn btn-primary btn-sm" onClick={saveCredentials} data-testid="youtube-save-credentials">
                  Salvar credenciais
                </button>
                {editingCredentials && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingCredentials(false)}>
                    Cancelar
                  </button>
                )}
              </div>
            </div>
            <p className="small muted">A chave secreta é guardada criptografada pelo Windows e nunca aparece de novo no app.</p>
          </div>
        )}

        {clientId && !editingCredentials && (
          <div className="row wrap">
            <button type="button" className="btn btn-primary" onClick={connectYouTube} disabled={connecting} data-testid="connect-youtube">
              {connecting ? 'Aguardando autorização no navegador…' : 'Conectar canal do YouTube'}
            </button>
            <span className="small muted">
              Client ID: <code className="path">{clientId}</code>
            </span>
            <button type="button" className="link-btn" onClick={() => setEditingCredentials(true)}>
              Alterar credenciais
            </button>
          </div>
        )}
        {connecting && <p className="small hint">Faça login e autorize no navegador que abriu. O app volta sozinho quando terminar.</p>}

        <AccountList
          accounts={byPlatform('youtube')}
          projects={projects}
          confirm={confirm}
          setConfirm={setConfirm}
          onToggleProject={toggleProject}
          onReconnect={connectYouTube}
          onDisconnect={disconnect}
          onRemove={remove}
        />
      </section>

      {/* Manual platforms */}
      {(['tiktok', 'instagram'] as const).map((platformId) => {
        const info = platforms?.find((p) => p.id === platformId)
        return (
          <section className="panel" key={platformId} data-testid={`platform-${platformId}`}>
            <div className="panel-head">
              <h2>
                <span className={`platform-badge pf-${platformId}`}>{PLATFORM_LABEL[platformId]}</span> Publicação manual
              </h2>
            </div>
            <p className="muted small">{info?.note}</p>
            <div className="row wrap">
              <input
                value={manualName[platformId] ?? ''}
                onChange={(e) => setManualName((m) => ({ ...m, [platformId]: e.target.value }))}
                placeholder="@perfil"
                maxLength={80}
                aria-label={`Nome da conta do ${PLATFORM_LABEL[platformId]}`}
                data-testid={`manual-name-${platformId}`}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => addManual(platformId)} data-testid={`add-manual-${platformId}`}>
                Adicionar conta
              </button>
            </div>
            <AccountList
              accounts={byPlatform(platformId)}
              projects={projects}
              confirm={confirm}
              setConfirm={setConfirm}
              onToggleProject={toggleProject}
              onDisconnect={disconnect}
              onRemove={remove}
            />
          </section>
        )
      })}

      <p className="muted small">Métricas e comentários chegam nas Fases 5 e 6, conforme o que cada API permitir.</p>
    </div>
  )
}

function AccountList(props: {
  accounts: Account[]
  projects: Project[]
  confirm: string | null
  setConfirm: (id: string | null) => void
  onToggleProject: (account: Account, projectId: string) => void
  onReconnect?: () => void
  onDisconnect: (account: Account) => void
  onRemove: (account: Account) => void
}) {
  if (props.accounts.length === 0) return null
  return (
    <ul className="account-list" data-testid="account-list">
      {props.accounts.map((a) => (
        <li key={a.id} className="account-item" data-testid="account-item" data-name={a.displayName} data-status={a.connectionStatus}>
          <div className="account-head">
            <strong>{a.displayName}</strong>
            <span className={`account-status as-${a.manual ? 'manual' : a.connectionStatus}`}>{a.manual ? 'Manual' : STATUS_LABEL[a.connectionStatus]}</span>
            {a.lastError && a.connectionStatus !== 'connected' && <span className="small form-error">{a.lastError}</span>}
          </div>
          {props.projects.length > 0 && (
            <div className="project-chips">
              <span className="small muted">Projetos:</span>
              {props.projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip${a.projectIds.includes(p.id) ? ' is-active' : ''}`}
                  aria-pressed={a.projectIds.includes(p.id)}
                  onClick={() => props.onToggleProject(a, p.id)}
                >
                  <span className="project-dot" style={{ background: p.color }} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <div className="row wrap">
            {!a.manual && a.connectionStatus !== 'connected' && props.onReconnect && (
              <button type="button" className="btn btn-primary btn-sm" onClick={props.onReconnect}>
                Reconectar
              </button>
            )}
            {props.confirm === a.id ? (
              <>
                {!a.manual && a.connectionStatus === 'connected' && (
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => props.onDisconnect(a)}>
                    Desconectar (revoga o acesso)
                  </button>
                )}
                <button type="button" className="btn btn-danger btn-sm" onClick={() => props.onRemove(a)}>
                  Remover conta
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => props.setConfirm(null)}>
                  Cancelar
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={() => props.setConfirm(a.id)}>
                {a.manual ? 'Remover…' : 'Desconectar…'}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
