import { useEffect, useMemo, useRef, useState } from 'react'
import {
  defaultEditSettings,
  EDITOR_FONTS,
  frameLayout,
  newTextOverlay,
  OUTPUT_PRESET_IDS,
  OUTPUT_PRESETS,
  outputSize,
  SAFE_AREAS,
  trimmedDuration,
  validateEdit,
  type ContentVersion,
  type EditPreset,
  type EditSettings,
  type EncoderInfo,
  type Frame,
  type OutputPresetId,
  type TextOverlay
} from '../../../shared/editor'
import { formatDuration, type ContentItem } from '../../../shared/media'
import type { Project } from '../../../shared/schemas'
import { api, unwrap } from '../api'
import type { NoticeState } from '../components/Notice'
import { PreviewStage, type PreviewControls, type SafeAreaId } from '../editor/PreviewStage'
import { renderTextPng } from '../editor/textRender'
import { formatPrecise, TrimBar } from '../editor/TrimBar'
import { useVersions } from '../editor/useVersions'
import { VersionsList } from '../editor/VersionsList'
import { assetState, displayName, thumbnailUrl } from '../media/format'

type Props = {
  content: ContentItem | null
  /** Settings to start from (e.g. "edit as new" from an existing version). */
  initialSettings: EditSettings | null
  assets: ContentItem[] | null
  projects: Project[]
  onOpen: (contentId: string, settings?: EditSettings) => void
  onNotice: (n: NoticeState) => void
  onError: (e: unknown) => void
}

type Tab = 'frame' | 'texts' | 'export'

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}${Math.random().toString(36).slice(2)}`)

/** Next free "Versão A", "Versão B", … name. */
function nextVersionName(versions: ContentVersion[] | null): string {
  const used = new Set((versions ?? []).map((v) => v.name.toLowerCase()))
  for (let i = 0; i < 26; i++) {
    const name = `Versão ${String.fromCharCode(65 + i)}`
    if (!used.has(name.toLowerCase())) return name
  }
  return `Versão ${(versions?.length ?? 0) + 1}`
}

export function EditorScreen({ content, initialSettings, assets, projects, onOpen, onNotice, onError }: Props) {
  if (!content) return <EditorPicker assets={assets} projects={projects} onOpen={onOpen} />
  return (
    <Editor
      key={content.id}
      content={content}
      initialSettings={initialSettings}
      projects={projects}
      onOpen={onOpen}
      onNotice={onNotice}
      onError={onError}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Picker                                                             */
/* ------------------------------------------------------------------ */

function EditorPicker({ assets, projects, onOpen }: Pick<Props, 'assets' | 'projects' | 'onOpen'>) {
  const [query, setQuery] = useState('')
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const ready = (assets ?? [])
    .filter((a) => assetState(a) === 'ready' && a.workflowStatus !== 'archived')
    .filter((a) => !query.trim() || displayName(a).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Preparar para publicar</p>
          <h1>Editor</h1>
        </div>
      </header>
      <section className="panel">
        <div className="panel-head">
          <h2>Escolha um vídeo</h2>
          <input
            type="search"
            className="toolbar-search"
            placeholder="Buscar"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar vídeo"
          />
        </div>
        {ready.length === 0 && <p className="muted">Nenhum vídeo disponível. Importe vídeos na Biblioteca.</p>}
        <ul className="picker-grid" data-testid="editor-picker">
          {ready.map((a) => {
            const project = a.projectId ? projectById.get(a.projectId) : undefined
            return (
              <li key={a.id}>
                <button type="button" className="picker-item" onClick={() => onOpen(a.id)} data-file-name={a.fileName}>
                  <span className="picker-thumb">{a.hasThumbnail && <img src={thumbnailUrl(a)} alt="" />}</span>
                  <span className="picker-name">{displayName(a)}</span>
                  <span className="small muted">
                    <span className="project-dot" style={{ background: project?.color ?? 'var(--text-faint)' }} />
                    {project?.name ?? 'Sem projeto'} · {formatDuration(a.durationSeconds)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Editor                                                             */
/* ------------------------------------------------------------------ */

function Editor({
  content,
  initialSettings,
  projects,
  onOpen,
  onNotice,
  onError
}: Omit<Props, 'content' | 'assets'> & { content: ContentItem }) {
  const duration = content.durationSeconds ?? 0
  const [settings, setSettings] = useState<EditSettings>(() => initialSettings ?? defaultEditSettings())
  const [tab, setTab] = useState<Tab>('frame')
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null)
  const [safeArea, setSafeArea] = useState<SafeAreaId>('tiktok')
  const [time, setTime] = useState(settings.trim.start)
  const [playing, setPlaying] = useState(false)
  const [versionName, setVersionName] = useState('')
  const [exporting, setExporting] = useState(false)
  const [presets, setPresets] = useState<EditPreset[]>([])
  const [presetName, setPresetName] = useState('')
  const [presetScope, setPresetScope] = useState<'project' | 'global'>(content.projectId ? 'project' : 'global')
  const [encoder, setEncoder] = useState<EncoderInfo | null>(null)
  const controls = useRef<PreviewControls | null>(null)
  const { versions } = useVersions(content.id)
  const project = projects.find((p) => p.id === content.projectId) ?? null

  const trimEnd = settings.trim.end ?? duration
  const source = { width: content.width ?? 1920, height: content.height ?? 1080 }
  const out = outputSize(settings.output.preset, source)
  const layout = frameLayout(source, out, settings.frame)
  const problems = validateEdit(settings, duration)
  const selectedText = settings.texts.find((t) => t.id === selectedTextId) ?? null

  useEffect(() => {
    if (!versionName && versions) setVersionName(nextVersionName(versions))
  }, [versions, versionName])

  useEffect(() => {
    unwrap(api.presets.list(content.projectId))
      .then(setPresets)
      .catch(onError)
    unwrap(api.editor.encoder())
      .then(setEncoder)
      .catch(() => setEncoder(null))
  }, [content.projectId, onError])

  // Space toggles playback (outside text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.code !== 'Space' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const update = (patch: Partial<EditSettings>) => setSettings((s) => ({ ...s, ...patch }))
  const updateFrame = (patch: Partial<Frame>) => setSettings((s) => ({ ...s, frame: { ...s.frame, ...patch } }))
  const updateText = (id: string, patch: Partial<TextOverlay>) =>
    setSettings((s) => ({ ...s, texts: s.texts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))

  function togglePlay() {
    const c = controls.current
    if (!c) return
    if (c.isPlaying()) {
      c.pause()
      setPlaying(false)
    } else {
      c.play()
      setPlaying(true)
    }
  }

  function addText() {
    const last = settings.texts.at(-1)
    // A new text copies the style of the last one, a bit lower.
    const text = last
      ? { ...last, id: newId(), text: 'Novo texto', y: Math.min(0.9, last.y + 0.1), start: null, end: null }
      : newTextOverlay(newId())
    update({ texts: [...settings.texts, text] })
    setSelectedTextId(text.id)
    setTab('texts')
  }

  function removeText(id: string) {
    update({ texts: settings.texts.filter((t) => t.id !== id) })
    if (selectedTextId === id) setSelectedTextId(null)
  }

  function applyPreset(id: string) {
    const preset = presets.find((p) => p.id === id)
    if (!preset) return
    // New ids, so texts from a preset never collide with existing ones.
    setSettings((s) => ({ ...preset.settings, trim: s.trim, texts: preset.settings.texts.map((t) => ({ ...t, id: newId() })) }))
    setSelectedTextId(null)
    onNotice({ tone: 'info', text: `Preset “${preset.name}” aplicado.` })
  }

  async function savePreset() {
    const name = presetName.trim()
    if (!name) {
      onNotice({ tone: 'error', text: 'Dê um nome ao preset.' })
      return
    }
    try {
      const { trim: _trim, ...style } = settings
      const saved = await unwrap(
        api.presets.save({ projectId: presetScope === 'project' ? content.projectId : null, name, settings: style })
      )
      setPresets(await unwrap(api.presets.list(content.projectId)))
      setPresetName('')
      onNotice({ tone: 'success', text: `Preset “${saved.name}” salvo.` })
    } catch (e) {
      onError(e)
    }
  }

  async function deletePreset(id: string) {
    try {
      await unwrap(api.presets.delete(id))
      setPresets((p) => p.filter((x) => x.id !== id))
    } catch (e) {
      onError(e)
    }
  }

  async function exportVersion() {
    if (problems.length) {
      onNotice({ tone: 'error', text: problems.join(' ') })
      return
    }
    setExporting(true)
    try {
      const overlays: { textId: string; png: Uint8Array }[] = []
      for (const text of settings.texts) {
        const png = await renderTextPng(text, out.width, out.height)
        if (png) overlays.push({ textId: text.id, png })
      }
      const version = await unwrap(
        api.versions.create({ contentId: content.id, name: versionName.trim() || nextVersionName(versions), settings, overlays })
      )
      onNotice({ tone: 'success', text: `Exportando “${version.name}”. Você pode continuar editando.` })
      setVersionName('')
    } catch (e) {
      onError(e)
    } finally {
      setExporting(false)
    }
  }

  const clipDuration = trimmedDuration(settings, duration)

  return (
    <div className="editor">
      <header className="editor-head">
        <div>
          <p className="eyebrow">
            Editor{project ? ` · ${project.name}` : ''} · original {content.width}×{content.height}, {formatDuration(duration)}
          </p>
          <h1 className="editor-title">{displayName(content)}</h1>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => onOpen('')}>
          Trocar de vídeo
        </button>
      </header>

      <div className="editor-body">
        <section className="editor-preview">
          <PreviewStage
            content={content}
            settings={settings}
            selectedTextId={selectedTextId}
            safeArea={safeArea}
            onTime={setTime}
            onSelectText={(id) => {
              setSelectedTextId(id)
              if (id) setTab('texts')
            }}
            onMoveText={(id, x, y) => updateText(id, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 })}
            onPan={(frame) => update({ frame })}
            controlsRef={controls}
          />
          <div className="editor-transport">
            <button type="button" className="btn btn-primary btn-sm" onClick={togglePlay} data-testid="editor-play">
              {playing ? 'Pausar' : 'Reproduzir'}
            </button>
            <span className="small muted" data-testid="editor-time">
              {formatPrecise(Math.max(0, time - settings.trim.start))} / {formatPrecise(clipDuration)}
            </span>
            {settings.output.preset === '9:16' && (
              <label className="inline-field">
                <span>Guias</span>
                <select value={safeArea} onChange={(e) => setSafeArea(e.target.value as SafeAreaId)} aria-label="Guias da plataforma">
                  <option value="none">Nenhuma</option>
                  {(Object.keys(SAFE_AREAS) as (keyof typeof SAFE_AREAS)[]).map((k) => (
                    <option key={k} value={k}>
                      {SAFE_AREAS[k].label} (aprox.)
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <TrimBar
            duration={duration}
            start={settings.trim.start}
            end={trimEnd}
            time={time}
            onChange={(start, end) => update({ trim: { start, end: end >= duration - 0.01 ? null : end } })}
            onSeek={(t) => controls.current?.seek(t)}
          />
          <div className="row wrap">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ trim: { start: Math.min(time, trimEnd - 0.2), end: settings.trim.end } })} data-testid="trim-set-start">
              Início aqui
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ trim: { start: settings.trim.start, end: Math.max(time, settings.trim.start + 0.2) } })} data-testid="trim-set-end">
              Fim aqui
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ trim: { start: 0, end: null } })}>
              Vídeo inteiro
            </button>
          </div>
        </section>

        <aside className="editor-panel">
          <div className="segmented tabs" role="tablist">
            {(
              [
                ['frame', 'Formato'],
                ['texts', `Textos${settings.texts.length ? ` (${settings.texts.length})` : ''}`],
                ['export', 'Exportar']
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)} data-testid={`tab-${id}`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'frame' && (
            <div className="editor-section">
              <label className="field">
                <span>Proporção</span>
                <select
                  value={settings.output.preset}
                  onChange={(e) => update({ output: { preset: e.target.value as OutputPresetId } })}
                  data-testid="output-preset"
                >
                  {OUTPUT_PRESET_IDS.map((id) => (
                    <option key={id} value={id}>
                      {id === 'original' ? 'Original' : OUTPUT_PRESETS[id].label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="small muted" data-testid="output-size">
                Saída: {out.width}×{out.height} px
              </p>
              <div className="field">
                <span>Enquadramento</span>
                <div className="segmented" role="group">
                  {(['cover', 'contain'] as const).map((fit) => (
                    <button key={fit} type="button" className={settings.frame.fit === fit ? 'is-active' : ''} aria-pressed={settings.frame.fit === fit} onClick={() => updateFrame({ fit, zoom: 1, x: 0, y: 0 })}>
                      {fit === 'cover' ? 'Preencher' : 'Mostrar tudo'}
                    </button>
                  ))}
                </div>
              </div>
              <Slider label="Zoom" value={settings.frame.zoom} min={0.5} max={3} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(zoom) => updateFrame({ zoom })} testId="frame-zoom" />
              <Slider label="Posição horizontal" value={settings.frame.x} min={-1} max={1} step={0.01} format={(v) => (v === 0 ? 'centro' : v < 0 ? `esq. ${Math.round(-v * 100)}` : `dir. ${Math.round(v * 100)}`)} onChange={(x) => updateFrame({ x })} disabled={layout.width === out.width} />
              <Slider label="Posição vertical" value={settings.frame.y} min={-1} max={1} step={0.01} format={(v) => (v === 0 ? 'centro' : v < 0 ? `cima ${Math.round(-v * 100)}` : `baixo ${Math.round(v * 100)}`)} onChange={(y) => updateFrame({ y })} disabled={layout.height === out.height} />
              <p className="small muted">Arraste o vídeo na prévia para reposicionar.</p>
              {layout.needsBackground && (
                <label className="field">
                  <span>Fundo</span>
                  <select value={settings.frame.background} onChange={(e) => updateFrame({ background: e.target.value as Frame['background'] })}>
                    <option value="blur">Vídeo desfocado</option>
                    <option value="black">Preto</option>
                  </select>
                </label>
              )}
              <label className="toggle">
                <input type="checkbox" checked={settings.audio.mute} onChange={(e) => update({ audio: { mute: e.target.checked } })} />
                <span>Sem áudio</span>
              </label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ frame: defaultEditSettings().frame })}>
                Redefinir enquadramento
              </button>
            </div>
          )}

          {tab === 'texts' && (
            <div className="editor-section">
              <div className="text-list">
                {settings.texts.map((t) => (
                  <button key={t.id} type="button" className={`text-chip${t.id === selectedTextId ? ' is-active' : ''}`} onClick={() => setSelectedTextId(t.id)}>
                    {t.text.trim() || '(vazio)'}
                  </button>
                ))}
                <button type="button" className="btn btn-primary btn-sm" onClick={addText} data-testid="add-text">
                  + Texto
                </button>
              </div>
              {!selectedText && settings.texts.length > 0 && <p className="small muted">Selecione um texto, ou clique nele na prévia.</p>}
              {selectedText && (
                <TextEditor
                  text={selectedText}
                  clipDuration={clipDuration}
                  clipTime={Math.max(0, time - settings.trim.start)}
                  onChange={(patch) => updateText(selectedText.id, patch)}
                  onRemove={() => removeText(selectedText.id)}
                />
              )}
            </div>
          )}

          {tab === 'export' && (
            <div className="editor-section">
              <label className="field">
                <span>Nome da versão</span>
                <input value={versionName} onChange={(e) => setVersionName(e.target.value)} maxLength={100} data-testid="version-name" />
              </label>
              <p className="small muted">
                {out.width}×{out.height} · {formatPrecise(clipDuration)} · H.264 + {settings.audio.mute || !content.audioCodec ? 'sem áudio' : 'AAC'}
                {encoder ? ` · ${encoder.label}` : ''}
              </p>
              {problems.length > 0 && <p className="form-error small">{problems.join(' ')}</p>}
              <button type="button" className="btn btn-primary" onClick={exportVersion} disabled={exporting || problems.length > 0} data-testid="export-version">
                {exporting ? 'Preparando…' : 'Exportar versão'}
              </button>
              <p className="small muted">O original nunca é alterado. A versão é gravada na pasta de exportação, numa subpasta do projeto.</p>

              <h3 className="small-heading">Presets</h3>
              {presets.length === 0 && <p className="small muted">Nenhum preset ainda.</p>}
              <ul className="preset-list">
                {presets.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="link-btn" onClick={() => applyPreset(p.id)} data-testid="apply-preset">
                      {p.name}
                    </button>
                    <span className="small muted">{p.projectId ? project?.name ?? 'projeto' : 'todos os projetos'}</span>
                    <button type="button" className="icon-btn" onClick={() => deletePreset(p.id)} aria-label={`Excluir preset ${p.name}`}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <div className="preset-save">
                <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Nome do preset" maxLength={80} data-testid="preset-name" />
                <select value={presetScope} onChange={(e) => setPresetScope(e.target.value as 'project' | 'global')} aria-label="Disponível em">
                  {content.projectId && <option value="project">Só {project?.name}</option>}
                  <option value="global">Todos os projetos</option>
                </select>
                <button type="button" className="btn btn-ghost btn-sm" onClick={savePreset} data-testid="save-preset">
                  Salvar estilo
                </button>
              </div>
              <p className="small muted">O preset guarda proporção, enquadramento e textos (não o corte).</p>
            </div>
          )}

          <div className="editor-section">
            <h3 className="small-heading">Versões deste vídeo</h3>
            <VersionsList
              versions={versions}
              compact
              onEditCopy={(v) => {
                setSettings({ ...v.settings, texts: v.settings.texts.map((t) => ({ ...t })) })
                setSelectedTextId(null)
                setVersionName('')
                onNotice({ tone: 'info', text: `Configurações de “${v.name}” carregadas. Exporte para criar uma nova versão.` })
              }}
              onNotice={onNotice}
              onError={onError}
            />
          </div>
        </aside>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pieces                                                             */
/* ------------------------------------------------------------------ */

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <label className={`slider${props.disabled ? ' is-disabled' : ''}`}>
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        data-testid={props.testId}
      />
    </label>
  )
}

const COLORS = ['#ffffff', '#000000', '#ffd400', '#ff3b30', '#34c759', '#0a84ff', '#ff2d92']

function TextEditor({
  text,
  clipDuration,
  clipTime,
  onChange,
  onRemove
}: {
  text: TextOverlay
  clipDuration: number
  clipTime: number
  onChange: (patch: Partial<TextOverlay>) => void
  onRemove: () => void
}) {
  const round = (v: number) => Math.round(v * 10) / 10
  return (
    <div className="text-editor" data-testid="text-editor">
      <textarea value={text.text} onChange={(e) => onChange({ text: e.target.value })} rows={2} maxLength={500} data-testid="text-content" />
      <div className="row wrap">
        <select value={text.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })} aria-label="Fonte" data-testid="text-font">
          {EDITOR_FONTS.map((f) => (
            <option key={f.family} value={f.family} style={{ fontFamily: f.family }}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={text.bold} onChange={(e) => onChange({ bold: e.target.checked })} />
          <span>Negrito</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={text.uppercase} onChange={(e) => onChange({ uppercase: e.target.checked })} />
          <span>MAIÚSCULAS</span>
        </label>
      </div>
      <Slider label="Tamanho" value={text.size} min={0.015} max={0.15} step={0.001} format={(v) => `${Math.round(v * 1000) / 10}%`} onChange={(size) => onChange({ size })} testId="text-size" />
      <Slider label="Largura máxima" value={text.maxWidth} min={0.3} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(maxWidth) => onChange({ maxWidth })} />
      <div className="field">
        <span>Cor</span>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} type="button" className={`swatch${text.color === c ? ' is-active' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onChange({ color: c })} />
          ))}
          <input type="color" value={text.color} onChange={(e) => onChange({ color: e.target.value })} aria-label="Outra cor" />
        </div>
      </div>
      <div className="row wrap">
        <label className="inline-field">
          <span>Contorno</span>
          <input type="color" value={text.outlineColor} onChange={(e) => onChange({ outlineColor: e.target.value })} aria-label="Cor do contorno" />
        </label>
        <input
          type="range"
          min={0}
          max={0.25}
          step={0.01}
          value={text.outlineWidth}
          onChange={(e) => onChange({ outlineWidth: Number(e.target.value) })}
          aria-label="Espessura do contorno"
        />
        <label className="toggle">
          <input type="checkbox" checked={text.shadow} onChange={(e) => onChange({ shadow: e.target.checked })} />
          <span>Sombra</span>
        </label>
      </div>
      <div className="row wrap">
        <label className="toggle">
          <input type="checkbox" checked={text.background !== null} onChange={(e) => onChange({ background: e.target.checked ? '#000000' : null })} />
          <span>Caixa de fundo</span>
        </label>
        {text.background !== null && (
          <input type="color" value={text.background} onChange={(e) => onChange({ background: e.target.value })} aria-label="Cor da caixa" />
        )}
        <div className="segmented" role="group" aria-label="Alinhamento">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} type="button" className={text.align === a ? 'is-active' : ''} onClick={() => onChange({ align: a })}>
              {a === 'left' ? 'Esq.' : a === 'center' ? 'Centro' : 'Dir.'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Posição rápida</span>
        <div className="segmented" role="group">
          {(
            [
              ['Topo', 0.12],
              ['Meio', 0.5],
              ['Base', 0.72]
            ] as const
          ).map(([label, y]) => (
            <button key={label} type="button" onClick={() => onChange({ x: 0.5, y })}>
              {label}
            </button>
          ))}
        </div>
        <span className="small muted">Ou arraste o texto na prévia. Mantenha fora das guias para não ficar coberto pela interface do app.</span>
      </div>
      <div className="field">
        <span>Quando aparece</span>
        <div className="row wrap">
          <label className="toggle">
            <input type="checkbox" checked={text.start === null && text.end === null} onChange={(e) => onChange(e.target.checked ? { start: null, end: null } : { start: round(clipTime), end: round(Math.min(clipDuration, clipTime + 2)) })} data-testid="text-whole-clip" />
            <span>O vídeo inteiro</span>
          </label>
          {(text.start !== null || text.end !== null) && (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ start: round(clipTime) })}>
                Começa aqui ({formatPrecise(text.start ?? 0)})
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ end: round(Math.max(clipTime, (text.start ?? 0) + 0.2)) })}>
                Termina aqui ({formatPrecise(text.end ?? clipDuration)})
              </button>
            </>
          )}
        </div>
      </div>
      <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={onRemove}>
        Remover texto
      </button>
    </div>
  )
}
