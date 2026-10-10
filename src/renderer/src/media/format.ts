import {
  aspectRatioLabel,
  formatDuration,
  formatFrameRate,
  type ContentItem,
  type ImportSummary
} from '../../../shared/media'
import type { NoticeState } from '../components/Notice'
import { plural } from '../format'

export const thumbnailUrl = (asset: ContentItem) =>
  `sm-media://thumb/${asset.id}?v=${encodeURIComponent(asset.updatedAt)}`

export const sourceUrl = (asset: ContentItem) => `sm-media://asset/${asset.id}?v=${encodeURIComponent(asset.updatedAt)}`

/** Display name: the user's title, else the file name. */
export const displayName = (asset: ContentItem) => asset.title ?? asset.fileName

/** One line of the most useful facts, e.g. "0:42 · 1080×1920 · 9:16 · 30 fps". */
export function metaLine(asset: ContentItem): string {
  if (asset.status !== 'ready') return ''
  const parts = [formatDuration(asset.durationSeconds)]
  if (asset.width && asset.height) {
    parts.push(`${asset.width}×${asset.height}`)
    parts.push(aspectRatioLabel(asset.width, asset.height))
  }
  if (asset.frameRate) parts.push(formatFrameRate(asset.frameRate))
  return parts.join(' · ')
}

export type AssetState = 'importing' | 'queued' | 'error' | 'missing' | 'ready'

export function assetState(asset: ContentItem): AssetState {
  if (asset.availability === 'missing') return 'missing'
  if (asset.status === 'error') return 'error'
  if (asset.status === 'processing') return 'importing'
  if (asset.status === 'pending') return 'queued'
  return 'ready'
}

export const STATE_LABEL: Record<AssetState, string> = {
  importing: 'Analisando…',
  queued: 'Na fila',
  error: 'Não importado',
  missing: 'Arquivo ausente',
  ready: 'Disponível'
}

export function importNotice(summary: ImportSummary): NoticeState | null {
  const parts: string[] = []
  if (summary.queued) parts.push(`Importando ${plural(summary.queued, 'vídeo', 'vídeos')}.`)
  if (summary.alreadyInLibrary) {
    parts.push(`${plural(summary.alreadyInLibrary, 'arquivo já está', 'arquivos já estão')} na biblioteca.`)
  }
  if (summary.skippedNonMedia) {
    parts.push(`${plural(summary.skippedNonMedia, 'arquivo que não é vídeo foi ignorado', 'arquivos que não são vídeo foram ignorados')}.`)
  }
  if (summary.truncated) parts.push('A pasta tem arquivos demais para uma vez; só os primeiros 10.000 foram considerados.')
  if (summary.errors.length) {
    const first = summary.errors[0]!.message
    parts.push(summary.errors.length === 1 ? first : `${first} (e mais ${summary.errors.length - 1} problemas)`)
  }
  if (!parts.length) return { tone: 'info', text: 'Nenhum vídeo foi encontrado.' }
  return { tone: summary.queued || !summary.errors.length ? 'info' : 'error', text: parts.join(' ') }
}
