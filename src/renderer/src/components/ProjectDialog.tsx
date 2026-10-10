import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { CreateProjectInput, Project, UpdateProjectInput } from '../../../shared/schemas'
import { errorMessage } from '../api'

const COLORS = ['#3d8bfd', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#e93d82', '#ffc53d']

type Props = {
  /** Editing an existing project; omitted to create a new one. */
  project?: Project
  onCancel: () => void
  onSubmit: (input: CreateProjectInput | UpdateProjectInput) => Promise<void>
}

/** Splits "#mma, #ufc fight" into ["#mma", "#ufc", "#fight"]. */
function parseHashtags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.startsWith('#') ? t : `#${t}`))
    )
  ]
}

export function ProjectDialog({ project, onCancel, onSubmit }: Props) {
  const [name, setName] = useState(project?.name ?? '')
  const [category, setCategory] = useState(project?.category ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [color, setColor] = useState(project?.color ?? COLORS[0]!)
  const [hashtags, setHashtags] = useState(project?.settings.defaultHashtags.join(' ') ?? '')
  const [captionTemplate, setCaptionTemplate] = useState(project?.settings.captionTemplate ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setError('Dê um nome ao projeto.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (project) {
        await onSubmit({
          id: project.id,
          name,
          category,
          description,
          color,
          settings: { ...project.settings, defaultHashtags: parseHashtags(hashtags), captionTemplate }
        })
      } else {
        await onSubmit({ name, category, description, color })
      }
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" onSubmit={submit} aria-labelledby="project-dialog-title">
        <h2 id="project-dialog-title">{project ? 'Editar projeto' : 'Novo projeto'}</h2>
        <p className="muted">
          Um projeto agrupa os conteúdos de um nicho (por exemplo MMA ou Skate) com suas contas, hashtags e preferências.
        </p>
        <label className="field">
          <span>Nome</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="ex.: MMA"
            data-testid="project-name"
          />
        </label>
        <label className="field">
          <span>
            Categoria <em className="optional">opcional</em>
          </span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} placeholder="ex.: Esporte" />
        </label>
        <label className="field">
          <span>
            Descrição <em className="optional">opcional</em>
          </span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={2} />
        </label>
        <div className="field">
          <span>Cor</span>
          <div className="swatches" role="radiogroup" aria-label="Cor do projeto">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                className={`swatch${color === c ? ' is-active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        {project && (
          <>
            <label className="field">
              <span>
                Hashtags padrão <em className="optional">usadas na publicação, Fase 3</em>
              </span>
              <input
                value={hashtags}
                onChange={(e) => setHashtags(e.target.value)}
                placeholder="#mma #ufc"
                data-testid="project-hashtags"
              />
            </label>
            <label className="field">
              <span>
                Modelo de descrição <em className="optional">Fase 3</em>
              </span>
              <textarea value={captionTemplate} onChange={(e) => setCaptionTemplate(e.target.value)} maxLength={5000} rows={3} />
            </label>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="project-submit">
            {busy ? 'Salvando…' : project ? 'Salvar' : 'Criar projeto'}
          </button>
        </div>
      </form>
    </div>
  )
}
