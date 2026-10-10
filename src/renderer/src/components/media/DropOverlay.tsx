import { useEffect, useRef, useState } from 'react'

/**
 * Accepts files and folders dragged onto the window from the desktop.
 * Also prevents the default browser behaviour of opening a dropped file.
 */
export function DropOverlay({ enabled, onDrop }: { enabled: boolean; onDrop: (files: File[]) => void }) {
  const [visible, setVisible] = useState(false)
  const depth = useRef(0)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setVisible(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabled ? 'copy' : 'none'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setVisible(false)
    }
    const onDropEvent = (e: DragEvent) => {
      e.preventDefault()
      depth.current = 0
      setVisible(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (enabled && files.length) dropRef.current(files)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDropEvent)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDropEvent)
    }
  }, [enabled])

  if (!visible) return null
  return (
    <div className={`drop-overlay${enabled ? '' : ' is-disabled'}`} aria-hidden="true">
      <div className="drop-target">
        {enabled ? (
          <>
            <strong>Solte para importar</strong>
            <span>Vídeos ou pastas inteiras vão para a Biblioteca.</span>
          </>
        ) : (
          <>
            <strong>Importação indisponível</strong>
            <span>O FFmpeg não está funcionando. Veja a Biblioteca para saber como resolver.</span>
          </>
        )}
      </div>
    </div>
  )
}
