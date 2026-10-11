import type { DestinationInput, PlatformId, PlatformInfo } from '../../shared/publishing'
import type { Connector, PublishableVersion } from './types'

const PLATFORMS: Record<Exclude<PlatformId, 'youtube'>, { name: string; uploadUrl: string; note: string }> = {
  tiktok: {
    name: 'TikTok',
    uploadUrl: 'https://www.tiktok.com/upload',
    note:
      'A publicação direta pela API do TikTok exige aprovação do app pelo TikTok, e apps não auditados só publicam como privado. ' +
      'Por enquanto a Social Machine prepara o vídeo e a legenda, abre o TikTok Studio e registra a publicação quando você confirmar.'
  },
  instagram: {
    name: 'Instagram',
    uploadUrl: 'https://www.instagram.com/',
    note:
      'A publicação pela API do Instagram exige conta profissional ligada a uma página do Facebook e um app aprovado pela Meta. ' +
      'Por enquanto a Social Machine prepara o vídeo e a legenda, abre o Instagram e registra a publicação quando você confirmar.'
  }
}

/**
 * Manual destinations: the user publishes in the platform's own app, the
 * Social Machine keeps the record (and later, the metrics it can read).
 */
export class ManualConnector implements Connector {
  constructor(private readonly platformId: Exclude<PlatformId, 'youtube'>) {}

  info(): PlatformInfo {
    const p = PLATFORMS[this.platformId]
    return { id: this.platformId, name: p.name, capabilities: ['manual'], note: p.note, uploadUrl: p.uploadUrl, configured: true }
  }

  validate(_version: PublishableVersion, destination: DestinationInput): string[] {
    const caption = [destination.caption ?? '', destination.hashtags.join(' ')].join(' ')
    const limit = this.platformId === 'tiktok' ? 4000 : 2200
    return caption.length > limit ? [`A legenda passa de ${limit} caracteres, o limite do ${PLATFORMS[this.platformId].name}.`] : []
  }

  notes(version: PublishableVersion): string[] {
    const notes: string[] = []
    if (version.height <= version.width) notes.push('Vídeo não vertical: no TikTok e no Reels o formato 9:16 aproveita a tela inteira.')
    return notes
  }
}
