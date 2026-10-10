import { useState } from 'react'
import type { MediaToolsStatus } from '../../../../shared/media'

type Props = {
  tools: MediaToolsStatus | null
  onRecheck: () => Promise<MediaToolsStatus>
  onError: (e: unknown) => void
}

/** Shown only when FFmpeg is unavailable: explains why import is disabled and how to fix it. */
export function ToolsBanner({ tools, onRecheck, onError }: Props) {
  const [checking, setChecking] = useState(false)
  if (!tools || tools.ok) return null

  async function recheck() {
    setChecking(true)
    try {
      await onRecheck()
    } catch (e) {
      onError(e)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="banner banner-error" role="alert" data-testid="tools-banner">
      <div>
        <strong>A importação de vídeos está indisponível.</strong> {tools.message}
        <details className="banner-details">
          <summary>Detalhes técnicos</summary>
          <code className="path">{tools.detail}</code>
        </details>
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={recheck} disabled={checking}>
        {checking ? 'Verificando…' : 'Verificar de novo'}
      </button>
    </div>
  )
}
