import { z } from 'zod'

/**
 * The editor's data model (Phase 2). One EditSettings object fully describes a
 * version: the renderer draws its preview from it and the main process builds
 * the FFmpeg command from it, using the same layout math below, so the
 * preview and the exported file match.
 */

/* ------------------------------------------------------------------ */
/* Output formats                                                     */
/* ------------------------------------------------------------------ */

export type OutputPresetId = '9:16' | '16:9' | '1:1' | '4:5' | 'original'

export const OUTPUT_PRESETS: Record<Exclude<OutputPresetId, 'original'>, { width: number; height: number; label: string }> = {
  '9:16': { width: 1080, height: 1920, label: 'Vertical 9:16 (TikTok, Reels, Shorts)' },
  '16:9': { width: 1920, height: 1080, label: 'Horizontal 16:9 (YouTube)' },
  '1:1': { width: 1080, height: 1080, label: 'Quadrado 1:1' },
  '4:5': { width: 1080, height: 1350, label: 'Retrato 4:5 (feed do Instagram)' }
}

export const OUTPUT_PRESET_IDS: readonly OutputPresetId[] = ['9:16', '16:9', '1:1', '4:5', 'original']

/** Even dimensions, at most 1920 on the long side, for H.264 4:2:0. */
export function originalOutputSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / Math.max(width, height))
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2)
  return { width: even(width), height: even(height) }
}

export function outputSize(preset: OutputPresetId, source: { width: number; height: number }): { width: number; height: number } {
  if (preset === 'original') return originalOutputSize(source.width, source.height)
  const { width, height } = OUTPUT_PRESETS[preset]
  return { width, height }
}

/* ------------------------------------------------------------------ */
/* Fonts                                                              */
/* ------------------------------------------------------------------ */

/**
 * Fonts offered in the editor. The first five are bundled with the app
 * (SIL Open Font License); the rest ship with Windows 10/11. Text is drawn
 * by the app itself, so the exported video always uses the same font as the preview.
 */
export const EDITOR_FONTS: readonly { family: string; label: string; bundled: boolean }[] = [
  { family: 'Montserrat', label: 'Montserrat', bundled: true },
  { family: 'Anton', label: 'Anton', bundled: true },
  { family: 'Bebas Neue', label: 'Bebas Neue', bundled: true },
  { family: 'Oswald', label: 'Oswald', bundled: true },
  { family: 'Bangers', label: 'Bangers', bundled: true },
  { family: 'Arial Black', label: 'Arial Black', bundled: false },
  { family: 'Impact', label: 'Impact', bundled: false },
  { family: 'Segoe UI', label: 'Segoe UI', bundled: false },
  { family: 'Georgia', label: 'Georgia', bundled: false }
]

/* ------------------------------------------------------------------ */
/* Settings schema                                                    */
/* ------------------------------------------------------------------ */

const HEX = /^#[0-9a-fA-F]{6}$/
const unit = z.number().min(0).max(1)
const time = z.number().min(0).max(24 * 3600)

export const TextOverlaySchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().max(500),
    fontFamily: z.string().min(1).max(80),
    /** Bold weight for variable fonts. */
    bold: z.boolean(),
    uppercase: z.boolean(),
    /** Font size as a fraction of the output height, so a style looks the same at any resolution. */
    size: z.number().min(0.01).max(0.3),
    color: z.string().regex(HEX),
    outlineColor: z.string().regex(HEX),
    /** Outline width as a fraction of the font size. 0 = none. */
    outlineWidth: z.number().min(0).max(0.3),
    shadow: z.boolean(),
    /** Optional box behind the text. */
    background: z.string().regex(HEX).nullable(),
    align: z.enum(['left', 'center', 'right']),
    /** Center of the text block, as fractions of the output frame. */
    x: unit,
    y: unit,
    /** Maximum line width as a fraction of the output width (text wraps). */
    maxWidth: z.number().min(0.2).max(1),
    /** Shown from/to these times, relative to the trimmed clip. null = whole clip. */
    start: time.nullable(),
    end: time.nullable()
  })
  .strict()
export type TextOverlay = z.infer<typeof TextOverlaySchema>

export const FrameSchema = z
  .object({
    /** 'cover' fills the frame (cropping); 'contain' shows the whole picture. */
    fit: z.enum(['cover', 'contain']),
    /** Multiplies the fit scale. 1 = exactly cover/contain. */
    zoom: z.number().min(0.5).max(4),
    /** Horizontal/vertical position: -1 = left/top edge aligned, 0 = centered, 1 = right/bottom edge aligned. */
    x: z.number().min(-1).max(1),
    y: z.number().min(-1).max(1),
    /** What fills uncovered areas. */
    background: z.enum(['blur', 'black'])
  })
  .strict()
export type Frame = z.infer<typeof FrameSchema>

export const EditSettingsSchema = z
  .object({
    version: z.literal(1),
    output: z.object({ preset: z.enum(['9:16', '16:9', '1:1', '4:5', 'original']) }).strict(),
    trim: z.object({ start: time, end: time.nullable() }).strict(),
    frame: FrameSchema,
    texts: z.array(TextOverlaySchema).max(20),
    audio: z.object({ mute: z.boolean() }).strict()
  })
  .strict()
export type EditSettings = z.infer<typeof EditSettingsSchema>

/** What a preset stores: everything except the clip-specific trim. */
export const PresetSettingsSchema = EditSettingsSchema.omit({ trim: true })
export type PresetSettings = z.infer<typeof PresetSettingsSchema>

export function defaultEditSettings(): EditSettings {
  return {
    version: 1,
    output: { preset: '9:16' },
    trim: { start: 0, end: null },
    frame: { fit: 'cover', zoom: 1, x: 0, y: 0, background: 'blur' },
    texts: [],
    audio: { mute: false }
  }
}

export function newTextOverlay(id: string, partial: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id,
    text: 'Seu texto aqui',
    fontFamily: 'Montserrat',
    bold: true,
    uppercase: false,
    size: 0.045,
    color: '#ffffff',
    outlineColor: '#000000',
    outlineWidth: 0.12,
    shadow: true,
    background: null,
    align: 'center',
    x: 0.5,
    y: 0.22,
    maxWidth: 0.86,
    start: null,
    end: null,
    ...partial
  }
}

/* ------------------------------------------------------------------ */
/* Layout math (shared by preview and render)                         */
/* ------------------------------------------------------------------ */

export type FrameLayout = {
  /** Size of the scaled source picture, in output pixels (even numbers). */
  width: number
  height: number
  /** Top-left position of the picture in the output frame (may be negative: cropped). */
  left: number
  top: number
  /** True when the picture leaves part of the frame uncovered (background needed). */
  needsBackground: boolean
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/**
 * Where the source picture goes in the output frame.
 * Position: at x = -1 the picture's left edge sits on the frame's left edge,
 * at x = 1 its right edge sits on the right edge (likewise for y).
 */
export function frameLayout(
  source: { width: number; height: number },
  output: { width: number; height: number },
  frame: Frame
): FrameLayout {
  const fit =
    frame.fit === 'cover'
      ? Math.max(output.width / source.width, output.height / source.height)
      : Math.min(output.width / source.width, output.height / source.height)
  const scale = fit * frame.zoom
  const width = even(source.width * scale)
  const height = even(source.height * scale)
  // `|| 0` turns -0 into 0, which would otherwise print as "-0" in filter arguments.
  const left = Math.round(((output.width - width) / 2) * (1 + frame.x)) || 0
  const top = Math.round(((output.height - height) / 2) * (1 + frame.y)) || 0
  const needsBackground = left > 0 || top > 0 || left + width < output.width || top + height < output.height
  return { width, height, left, top, needsBackground }
}

/** Trimmed duration in seconds, given the source duration. */
export function trimmedDuration(settings: EditSettings, sourceDuration: number): number {
  const end = settings.trim.end === null ? sourceDuration : Math.min(settings.trim.end, sourceDuration)
  return Math.max(0, end - Math.min(settings.trim.start, end))
}

/** Problems that make a settings object impossible to render for this source. */
export function validateEdit(settings: EditSettings, sourceDuration: number): string[] {
  const problems: string[] = []
  if (settings.trim.start >= sourceDuration) problems.push('O início do corte está depois do fim do vídeo.')
  if (trimmedDuration(settings, sourceDuration) < 0.2) problems.push('O trecho cortado é curto demais (mínimo 0,2 s).')
  for (const t of settings.texts) {
    if (t.start !== null && t.end !== null && t.end <= t.start) {
      problems.push(`O texto “${t.text.slice(0, 30)}” termina antes de começar.`)
    }
  }
  return problems
}

/* ------------------------------------------------------------------ */
/* Platform safe areas (approximate guides for the preview)           */
/* ------------------------------------------------------------------ */

/**
 * Regions of a 9:16 frame typically covered by each app's buttons and captions,
 * as fractions of the frame. Approximate and subject to change by the
 * platforms; shown only as a guide in the preview.
 */
export const SAFE_AREAS: Record<'tiktok' | 'reels' | 'shorts', { label: string; zones: { x: number; y: number; w: number; h: number }[] }> = {
  tiktok: {
    label: 'TikTok',
    zones: [
      { x: 0, y: 0, w: 1, h: 0.08 },
      { x: 0.86, y: 0.35, w: 0.14, h: 0.5 },
      { x: 0, y: 0.8, w: 1, h: 0.2 }
    ]
  },
  reels: {
    label: 'Reels',
    zones: [
      { x: 0, y: 0, w: 1, h: 0.07 },
      { x: 0.86, y: 0.45, w: 0.14, h: 0.4 },
      { x: 0, y: 0.82, w: 1, h: 0.18 }
    ]
  },
  shorts: {
    label: 'Shorts',
    zones: [
      { x: 0, y: 0, w: 1, h: 0.07 },
      { x: 0.85, y: 0.4, w: 0.15, h: 0.45 },
      { x: 0, y: 0.83, w: 1, h: 0.17 }
    ]
  }
}

/* ------------------------------------------------------------------ */
/* Versions and presets                                               */
/* ------------------------------------------------------------------ */

export type VersionStatus = 'draft' | 'rendering' | 'ready' | 'error'

export type ContentVersion = {
  id: string
  contentId: string
  name: string
  status: VersionStatus
  /** 0..1 while rendering. */
  progress: number
  errorMessage: string | null
  settings: EditSettings
  filePath: string | null
  fileSize: number | null
  durationSeconds: number | null
  width: number | null
  height: number | null
  aspectRatio: string | null
  encoder: string | null
  hasThumbnail: boolean
  createdAt: string
  updatedAt: string
}

export type EditPreset = {
  id: string
  projectId: string | null
  name: string
  settings: PresetSettings
  createdAt: string
  updatedAt: string
}

/** One overlay image per text, rendered by the renderer at output resolution. */
export type OverlayImage = { textId: string; png: Uint8Array }

export const MAX_OVERLAY_BYTES = 12 * 1024 * 1024

const contentId = z.string().uuid('Conteúdo inválido')
const versionName = z.string().trim().min(1, 'Dê um nome à versão').max(100, 'Nome longo demais')

export const RenderVersionInputSchema = z
  .object({
    contentId,
    name: versionName,
    settings: EditSettingsSchema,
    overlays: z
      .array(z.object({ textId: z.string().min(1).max(64), png: z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'Imagem inválida') }).strict())
      .max(20)
  })
  .strict()
export type RenderVersionInput = z.infer<typeof RenderVersionInputSchema>

export const VersionIdInputSchema = z.object({ id: z.string().uuid('Versão inválida') }).strict()
export const ContentIdInputSchema = z.object({ contentId }).strict()

export const SavePresetInputSchema = z
  .object({
    projectId: z.string().uuid('Projeto inválido').nullable(),
    name: z.string().trim().min(1, 'Dê um nome ao preset').max(80),
    settings: PresetSettingsSchema
  })
  .strict()
export type SavePresetInput = z.infer<typeof SavePresetInputSchema>

export const PresetIdInputSchema = z.object({ id: z.string().uuid('Preset inválido') }).strict()

export type EncoderInfo = { id: string; label: string; hardware: boolean }

export type VersionEvent = { type: 'version'; version: ContentVersion } | { type: 'version-removed'; id: string; contentId: string }
