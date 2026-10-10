import { useEffect } from 'react'

export type NoticeState = { tone: 'success' | 'error' | 'info'; text: string }

export function Notice({ notice, onDismiss }: { notice: NoticeState; onDismiss: () => void }) {
  useEffect(() => {
    // Errors stay until dismissed; confirmations fade out.
    if (notice.tone === 'error') return
    const timer = window.setTimeout(onDismiss, 4000)
    return () => window.clearTimeout(timer)
  }, [notice, onDismiss])

  return (
    <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button type="button" className="notice-close" onClick={onDismiss} aria-label="Fechar">
        ×
      </button>
    </div>
  )
}
