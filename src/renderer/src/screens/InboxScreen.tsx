import { useEffect, useMemo, useState } from 'react'
import type { InboxItem } from '../../../shared/inbox'
import type { PlatformId } from '../../../shared/publishing'
import type { Project } from '../../../shared/schemas'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { formatDateTime, formatRelative } from '../format'
import { useInbox } from '../inbox/useInbox'
import { PLATFORM_LABEL } from '../publishing/PublicationsList'

type Props = {
  projects: Project[]
  onOpenContent: (contentId: string) => void
  onOpenAccounts: () => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

type StatusFilter = 'unread' | 'open' | 'all' | 'resolved'

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'unread', label: 'Não lidos' },
  { id: 'open', label: 'Abertos' },
  { id: 'all', label: 'Todos' },
  { id: 'resolved', label: 'Resolvidos' }
]

const STATUS_TAG: Record<InboxItem['responseStatus'], string | null> = { none: null, resolved: 'Resolvido', replied: 'Respondido' }

/** Comments from every connected account in one place; replies are written and sent by you. */
export function InboxScreen({ projects, onOpenContent, onOpenAccounts, onNotice, onError }: Props) {
  const { items, status } = useInbox()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [project, setProject] = useState('all')
  const [platform, setPlatform] = useState<'all' | PlatformId>('all')
  const [account, setAccount] = useState('all')
  const [content, setContent] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])

  const contents = useMemo(() => {
    const map = new Map<string, string>()
    for (const i of items ?? []) if (i.contentId && i.contentName) map.set(i.contentId, i.contentName)
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [items])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (items ?? []).filter(
      (i) =>
        !i.own &&
        (statusFilter === 'all' ||
          (statusFilter === 'unread' && i.readStatus === 'unread') ||
          (statusFilter === 'open' && i.responseStatus === 'none') ||
          (statusFilter === 'resolved' && i.responseStatus !== 'none')) &&
        (project === 'all' || (project === 'none' ? i.projectId === null : i.projectId === project)) &&
        (platform === 'all' || i.platformId === platform) &&
        (account === 'all' || i.accountId === account) &&
        (content === 'all' || i.contentId === content) &&
        (!q || i.text.toLowerCase().includes(q) || (i.author ?? '').toLowerCase().includes(q))
    )
  }, [items, statusFilter, project, platform, account, content, search])

  const current = items?.find((i) => i.id === selected) ?? null
  const thread = useMemo(
    () =>
      current && current.threadId
        ? (items ?? []).filter((i) => i.accountId === current.accountId && i.threadId === current.threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : current
          ? [current]
          : [],
    [items, current]
  )
  const top = thread.find((i) => i.type === 'comment') ?? current
  const accountStatus = status?.find((s) => s.accountId === current?.accountId)

  // Opening a comment marks it as read (it can be marked unread again).
  useEffect(() => {
    if (current && current.readStatus === 'unread') void unwrap(api.inbox.setRead([current.id], true)).catch(() => undefined)
    setReply('')
  }, [current?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn()
      if (done) onNotice({ tone: 'success', text: done })
    } catch (e) {
      onError(e)
    }
  }

  async function sync() {
    setSyncing(true)
    try {
      const result = await unwrap(api.inbox.sync())
      if (result.accounts === 0) onNotice({ tone: 'info', text: 'Nenhuma conta conectada oferece comentários pela API.' })
      else if (result.errors.length) onNotice({ tone: 'error', text: result.errors.join(' ') })
      else onNotice({ tone: 'success', text: result.newItems ? `${result.newItems} comentário(s) novo(s).` : 'Nenhum comentário novo.' })
    } catch (e) {
      onError(e)
    } finally {
      setSyncing(false)
    }
  }

  async function sendReply() {
    if (!current || !top || !reply.trim()) return
    setSending(true)
    try {
      await unwrap(api.inbox.reply(top.id, reply.trim()))
      setReply('')
      onNotice({ tone: 'success', text: `Resposta enviada para ${top.author ?? 'o comentário'}.` })
    } catch (e) {
      onError(e)
    } finally {
      setSending(false)
    }
  }

  const unreadVisible = visible.filter((i) => i.readStatus === 'unread').map((i) => i.id)
  const canReply = Boolean(top?.canReply && accountStatus?.reply)

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Interações</p>
          <h1>Inbox</h1>
        </div>
        <div className="row wrap">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={unreadVisible.length === 0}
            onClick={() => act(() => unwrap(api.inbox.setRead(unreadVisible, true)))}
            data-testid="inbox-read-all"
          >
            Marcar como lidos ({unreadVisible.length})
          </button>
          <button type="button" className="btn btn-primary" onClick={sync} disabled={syncing} data-testid="inbox-sync">
            {syncing ? 'Sincronizando…' : 'Sincronizar'}
          </button>
        </div>
      </header>

      <section className="panel inbox-accounts" data-testid="inbox-accounts">
        <h2 className="small-heading">O que cada conta oferece</h2>
        {status && status.length === 0 && (
          <p className="muted small">
            Nenhuma conta.{' '}
            <button type="button" className="link-btn" onClick={onOpenAccounts}>
              Adicionar contas
            </button>
          </p>
        )}
        <ul className="inbox-account-list">
          {(status ?? []).map((s) => (
            <li key={s.accountId} data-testid="inbox-account" data-account={s.accountName}>
              <span className={`platform-badge pf-${s.platformId}`}>{PLATFORM_LABEL[s.platformId]}</span>
              <strong>{s.accountName}</strong>
              <span className={`cap ${s.readComments ? 'is-on' : 'is-off'}`}>{s.readComments ? '✓' : '—'} Comentários</span>
              <span className={`cap ${s.reply ? 'is-on' : 'is-off'}`} data-testid="cap-reply">
                {s.reply ? '✓' : '—'} Respostas
              </span>
              <span className="cap is-off" title="As APIs não oferecem notificações gerais (curtidas, novos seguidores) para este app.">
                — Notificações
              </span>
              <span className="small muted inbox-account-note">
                {s.error ? (
                  <span className="form-error">{s.error}</span>
                ) : s.limitation ? (
                  s.limitation
                ) : s.checkedAt ? (
                  `sincronizado ${formatRelative(s.checkedAt)}`
                ) : (
                  'ainda não sincronizado'
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="filter-row" role="group" aria-label="Filtros">
        <div className="segmented" role="tablist" aria-label="Situação">
          {STATUS_FILTERS.map((f) => (
            <button key={f.id} type="button" className={statusFilter === f.id ? 'is-active' : ''} onClick={() => setStatusFilter(f.id)} data-testid={`inbox-filter-${f.id}`}>
              {f.label}
            </button>
          ))}
        </div>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Projeto">
          <option value="all">Todos os projetos</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="none">Sem projeto</option>
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value as 'all' | PlatformId)} aria-label="Plataforma">
          <option value="all">Todas as plataformas</option>
          {(['youtube', 'tiktok', 'instagram'] as PlatformId[]).map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p]}
            </option>
          ))}
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Conta">
          <option value="all">Todas as contas</option>
          {(status ?? []).map((a) => (
            <option key={a.accountId} value={a.accountId}>
              {a.accountName}
            </option>
          ))}
        </select>
        <select value={content} onChange={(e) => setContent(e.target.value)} aria-label="Conteúdo" data-testid="inbox-filter-content">
          <option value="all">Todos os conteúdos</option>
          {contents.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar texto ou autor" aria-label="Buscar" className="inbox-search" data-testid="inbox-search" />
      </div>

      <div className="inbox-layout">
        <section className="panel inbox-list-panel">
          {items === null && <p className="muted small">Carregando…</p>}
          {items && visible.length === 0 && (
            <p className="muted small" data-testid="inbox-empty">
              {items.length === 0 ? 'Nenhum comentário ainda. Clique em Sincronizar para buscar os comentários das contas conectadas.' : 'Nada com esses filtros.'}
            </p>
          )}
          <ul className="inbox-list" data-testid="inbox-list">
            {visible.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  className={`inbox-row${i.readStatus === 'unread' ? ' is-unread' : ''}${selected === i.id ? ' is-selected' : ''}`}
                  onClick={() => setSelected(i.id)}
                  data-testid="inbox-item"
                  data-read={i.readStatus}
                  data-response={i.responseStatus}
                >
                  <span className="inbox-row-head">
                    {i.readStatus === 'unread' && <span className="unread-dot" aria-label="Não lido" />}
                    <span className={`platform-badge pf-${i.platformId}`}>{PLATFORM_LABEL[i.platformId]}</span>
                    <span className="inbox-row-where">
                      {i.projectId && (
                        <span className="project-dot" style={{ background: projectById.get(i.projectId)?.color ?? 'var(--text-faint)' }} aria-hidden="true" />
                      )}
                      {i.accountName} · {i.type === 'reply' ? 'Resposta em ' : ''}
                      {i.contentName ?? i.videoTitle ?? 'vídeo do canal'}
                    </span>
                    <span className="small muted inbox-row-time">{formatRelative(i.createdAt)}</span>
                  </span>
                  <span className="inbox-row-text">“{i.text}”</span>
                  <span className="small muted">
                    {i.author ?? 'Anônimo'}
                    {STATUS_TAG[i.responseStatus] ? <span className={`tag tag-${i.responseStatus}`}>{STATUS_TAG[i.responseStatus]}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <aside className="panel inbox-detail" data-testid="inbox-detail">
          {!current && <p className="muted small">Escolha um comentário para ver a conversa e responder.</p>}
          {current && (
            <>
              <div className="publication-head">
                <span className={`platform-badge pf-${current.platformId}`}>{PLATFORM_LABEL[current.platformId]}</span>
                <strong>{current.accountName}</strong>
                <span className="small muted">{current.contentName ?? current.videoTitle ?? `vídeo ${current.externalVideoId ?? ''}`}</span>
              </div>
              <ol className="thread" data-testid="thread">
                {thread.map((t) => (
                  <li key={t.id} className={`thread-item${t.own ? ' is-own' : ''}${t.type === 'reply' ? ' is-reply' : ''}`} data-testid="thread-item">
                    <span className="small">
                      <strong>{t.own ? `${t.author ?? 'Você'} (você)` : (t.author ?? 'Anônimo')}</strong>{' '}
                      <span className="muted">{formatDateTime(t.createdAt)}</span>
                      {t.likeCount ? <span className="muted"> · {t.likeCount} curtida(s)</span> : null}
                    </span>
                    <p className="thread-text">{t.text}</p>
                  </li>
                ))}
              </ol>
              <p className="small muted">YouTube envia até algumas respostas por conversa; abra no YouTube para ver todas.</p>
              <div className="row wrap">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => act(() => unwrap(api.inbox.setRead([current.id], current.readStatus !== 'unread' ? false : true)))}
                  data-testid="toggle-read"
                >
                  {current.readStatus === 'unread' ? 'Marcar como lido' : 'Marcar como não lido'}
                </button>
                {current.responseStatus === 'none' ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(() => unwrap(api.inbox.setResolved([current.id], true)))} data-testid="resolve">
                    Marcar como resolvido
                  </button>
                ) : current.responseStatus === 'resolved' ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => act(() => unwrap(api.inbox.setResolved([current.id], false)))} data-testid="reopen">
                    Reabrir
                  </button>
                ) : null}
                {current.url && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => unwrap(api.inbox.open(current.id)).then(() => undefined, onError)} data-testid="open-original">
                    Abrir no {PLATFORM_LABEL[current.platformId]}
                  </button>
                )}
                {current.contentId && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenContent(current.contentId!)} data-testid="open-content">
                    Abrir conteúdo
                  </button>
                )}
              </div>
              {canReply ? (
                <div className="reply-box">
                  <label className="field">
                    <span>Responder a {top?.author ?? 'este comentário'}</span>
                    <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={10_000} data-testid="reply-text" />
                  </label>
                  <div className="row">
                    <button type="button" className="btn btn-primary btn-sm" onClick={sendReply} disabled={sending || !reply.trim()} data-testid="reply-send">
                      {sending ? 'Enviando…' : 'Enviar resposta'}
                    </button>
                    <span className="small muted">Publicada pelo seu canal, como resposta pública.</span>
                  </div>
                </div>
              ) : (
                <p className="small muted" data-testid="reply-unavailable">
                  {!top?.canReply
                    ? 'A plataforma não permite responder a este comentário.'
                    : (accountStatus?.limitation ?? 'Responder não está disponível para esta conta.')}
                </p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
