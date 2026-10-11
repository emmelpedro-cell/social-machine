import type { TextOverlay } from '../../../shared/editor'

/**
 * Draws text overlays. The same function draws the live preview and the
 * full-resolution PNGs sent to FFmpeg, so what you see is what is exported.
 */

export type TextBox = { id: string; x: number; y: number; width: number; height: number }

/** Families bundled with the app (see fonts/ and styles.css). */
const BUNDLED = new Set(['Montserrat', 'Anton', 'Bebas Neue', 'Oswald', 'Bangers'])

export function fontFor(text: TextOverlay, px: number): string {
  const weight = text.bold ? 800 : 400
  const family = BUNDLED.has(text.fontFamily) ? `"${text.fontFamily}"` : `"${text.fontFamily}", "Segoe UI", Arial, sans-serif`
  return `${weight} ${px}px ${family}`
}

/** Waits until the fonts used by these texts are ready, so the first frame isn't drawn with a fallback. */
export async function loadFonts(texts: readonly TextOverlay[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all(
    texts.map((t) => document.fonts.load(fontFor(t, 64), t.text || 'A').catch(() => [] as FontFace[]))
  )
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = words[0]!
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

/** Whether a text is visible at time `t` (seconds into the trimmed clip). */
export function isVisibleAt(text: TextOverlay, t: number): boolean {
  return (text.start === null || t >= text.start) && (text.end === null || t < text.end)
}

/**
 * Draws one text onto a canvas of the output size and returns its bounding box
 * (in output pixels), for hit-testing in the preview.
 */
export function drawText(ctx: CanvasRenderingContext2D, text: TextOverlay, width: number, height: number): TextBox | null {
  const content = text.uppercase ? text.text.toLocaleUpperCase('pt-BR') : text.text
  if (!content.trim()) return null
  const px = Math.max(4, Math.round(text.size * height))
  ctx.save()
  ctx.font = fontFor(text, px)
  ctx.textBaseline = 'middle'
  const maxWidth = text.maxWidth * width
  const lines = wrap(ctx, content, maxWidth)
  const lineHeight = px * 1.18
  const widths = lines.map((l) => ctx.measureText(l).width)
  const blockWidth = Math.min(maxWidth, Math.max(...widths, 1))
  const blockHeight = lineHeight * lines.length
  const cx = text.x * width
  const cy = text.y * height
  const left = cx - blockWidth / 2
  const top = cy - blockHeight / 2

  if (text.background) {
    const pad = px * 0.35
    ctx.fillStyle = text.background
    roundRect(ctx, left - pad, top - pad * 0.6, blockWidth + pad * 2, blockHeight + pad * 1.2, px * 0.25)
    ctx.fill()
  }

  ctx.textAlign = text.align
  const anchorX = text.align === 'left' ? left : text.align === 'right' ? left + blockWidth : cx
  const outline = text.outlineWidth * px
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  lines.forEach((line, i) => {
    const y = top + lineHeight * (i + 0.5)
    if (text.shadow) {
      ctx.save()
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)'
      ctx.shadowBlur = px * 0.18
      ctx.shadowOffsetY = px * 0.06
      ctx.fillStyle = text.color
      ctx.fillText(line, anchorX, y)
      ctx.restore()
    }
    if (outline > 0) {
      ctx.strokeStyle = text.outlineColor
      // The stroke is centred on the glyph edge; double it so the visible outline is `outline` wide.
      ctx.lineWidth = outline * 2
      ctx.strokeText(line, anchorX, y)
    }
    ctx.fillStyle = text.color
    ctx.fillText(line, anchorX, y)
  })
  ctx.restore()
  return { id: text.id, x: left, y: top, width: blockWidth, height: blockHeight }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Renders one text to a transparent full-frame PNG for export. */
export async function renderTextPng(text: TextOverlay, width: number, height: number): Promise<Uint8Array | null> {
  await loadFonts([text])
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D indisponível')
  if (!drawText(ctx, text, width, height)) return null
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Não foi possível gerar a imagem do texto')
  return new Uint8Array(await blob.arrayBuffer())
}
