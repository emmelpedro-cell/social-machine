import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import {
  frameLayout,
  outputSize,
  SAFE_AREAS,
  type EditSettings,
  type Frame,
  type TextOverlay
} from '../../../shared/editor'
import type { ContentItem } from '../../../shared/media'
import { sourceUrl } from '../media/format'
import { drawText, isVisibleAt, loadFonts, type TextBox } from './textRender'

export type SafeAreaId = 'none' | keyof typeof SAFE_AREAS

type Props = {
  content: ContentItem
  settings: EditSettings
  selectedTextId: string | null
  safeArea: SafeAreaId
  /** Seconds in the source file. */
  onTime: (sourceTime: number) => void
  onSelectText: (id: string | null) => void
  onMoveText: (id: string, x: number, y: number) => void
  onPan: (frame: Frame) => void
  /** Exposes play/seek controls to the parent. */
  controlsRef: MutableRefObject<PreviewControls | null>
}

export type PreviewControls = {
  play: () => void
  pause: () => void
  seek: (sourceTime: number) => void
  isPlaying: () => boolean
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/**
 * Live preview of a version: the clip framed exactly as the export will be
 * (same layout math), the blurred background, the text layer drawn by the
 * export renderer, and optional platform safe-area guides.
 */
export function PreviewStage({
  content,
  settings,
  selectedTextId,
  safeArea,
  onTime,
  onSelectText,
  onMoveText,
  onPan,
  controlsRef
}: Props) {
  const source = { width: content.width ?? 1920, height: content.height ?? 1080 }
  const out = outputSize(settings.output.preset, source)
  const layout = frameLayout(source, out, settings.frame)
  const fg = useRef<HTMLVideoElement>(null)
  const bg = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const boxes = useRef<TextBox[]>([])
  const [sourceTime, setSourceTime] = useState(settings.trim.start)
  const [fontsReady, setFontsReady] = useState(0)
  const drag = useRef<
    | { kind: 'text'; id: string; dx: number; dy: number }
    | { kind: 'pan'; startX: number; startY: number; frame: Frame; rect: DOMRect }
    | null
  >(null)

  const trimEnd = settings.trim.end ?? content.durationSeconds ?? 0
  const clipTime = Math.max(0, sourceTime - settings.trim.start)

  // ---- playback ---------------------------------------------------------
  useEffect(() => {
    controlsRef.current = {
      play: () => {
        const v = fg.current
        if (!v) return
        if (v.currentTime < settings.trim.start || v.currentTime >= trimEnd - 0.05) v.currentTime = settings.trim.start
        void v.play()
      },
      pause: () => fg.current?.pause(),
      seek: (t) => {
        if (fg.current) fg.current.currentTime = t
      },
      isPlaying: () => Boolean(fg.current && !fg.current.paused)
    }
  }, [controlsRef, settings.trim.start, trimEnd])

  const syncBackground = useCallback(() => {
    const a = fg.current
    const b = bg.current
    if (!a || !b) return
    if (Math.abs(b.currentTime - a.currentTime) > 0.15) b.currentTime = a.currentTime
    if (a.paused && !b.paused) b.pause()
    if (!a.paused && b.paused) void b.play().catch(() => undefined)
  }, [])

  const onTimeUpdate = () => {
    const v = fg.current
    if (!v) return
    // Loop inside the trimmed range.
    if (!v.paused && v.currentTime >= trimEnd) v.currentTime = settings.trim.start
    setSourceTime(v.currentTime)
    onTime(v.currentTime)
    syncBackground()
  }

  // Keep the playhead inside the trim when it changes.
  useEffect(() => {
    const v = fg.current
    if (v && (v.currentTime < settings.trim.start || v.currentTime > trimEnd)) v.currentTime = settings.trim.start
  }, [settings.trim.start, trimEnd])

  // ---- text layer -------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    void loadFonts(settings.texts).then(() => {
      if (!cancelled) setFontsReady((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [settings.texts])

  useLayoutEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    if (c.width !== out.width) c.width = out.width
    if (c.height !== out.height) c.height = out.height
    ctx.clearRect(0, 0, c.width, c.height)
    const drawn: TextBox[] = []
    for (const text of settings.texts) {
      const visible = isVisibleAt(text, clipTime) || text.id === selectedTextId
      if (!visible) continue
      ctx.globalAlpha = isVisibleAt(text, clipTime) ? 1 : 0.35
      const box = drawText(ctx, text, out.width, out.height)
      if (box) drawn.push(box)
    }
    ctx.globalAlpha = 1
    const selected = drawn.find((b) => b.id === selectedTextId)
    if (selected) {
      ctx.save()
      ctx.strokeStyle = 'rgba(61, 139, 253, 0.95)'
      ctx.lineWidth = Math.max(2, out.height / 400)
      ctx.setLineDash([out.height / 120, out.height / 160])
      ctx.strokeRect(selected.x - 8, selected.y - 8, selected.width + 16, selected.height + 16)
      ctx.restore()
    }
    boxes.current = drawn
  }, [settings.texts, out.width, out.height, clipTime, selectedTextId, fontsReady])

  // ---- dragging: texts move, otherwise the picture pans -------------------
  const toOutput = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: ((e.clientX - rect.left) / rect.width) * out.width, y: ((e.clientY - rect.top) / rect.height) * out.height, rect }
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const p = toOutput(e)
    const hit = [...boxes.current]
      .reverse()
      .find((b) => p.x >= b.x - 12 && p.x <= b.x + b.width + 12 && p.y >= b.y - 12 && p.y <= b.y + b.height + 12)
    e.currentTarget.setPointerCapture(e.pointerId)
    if (hit) {
      const text = settings.texts.find((t) => t.id === hit.id) as TextOverlay
      onSelectText(hit.id)
      drag.current = { kind: 'text', id: hit.id, dx: text.x * out.width - p.x, dy: text.y * out.height - p.y }
    } else {
      onSelectText(null)
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, frame: settings.frame, rect: p.rect }
    }
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    if (d.kind === 'text') {
      const p = toOutput(e)
      onMoveText(d.id, clamp((p.x + d.dx) / out.width, 0, 1), clamp((p.y + d.dy) / out.height, 0, 1))
      return
    }
    // Pan: convert the pointer delta into the -1..1 position range of the overflowing axis.
    const scale = out.width / d.rect.width
    const overflowX = (out.width - layout.width) / 2
    const overflowY = (out.height - layout.height) / 2
    const dx = (e.clientX - d.startX) * scale
    const dy = (e.clientY - d.startY) * scale
    const x = overflowX !== 0 ? clamp(d.frame.x + dx / overflowX, -1, 1) : d.frame.x
    const y = overflowY !== 0 ? clamp(d.frame.y + dy / overflowY, -1, 1) : d.frame.y
    onPan({ ...d.frame, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 })
  }

  const endDrag = () => {
    drag.current = null
  }

  const pct = (v: number, of: number) => `${(v / of) * 100}%`
  const src = sourceUrl(content)

  return (
    <div className="stage-wrap">
      <div
        className="stage"
        style={{ aspectRatio: `${out.width} / ${out.height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="editor-stage"
        data-output={`${out.width}x${out.height}`}
      >
        {layout.needsBackground && settings.frame.background === 'blur' && (
          <video ref={bg} className="stage-bg" src={src} muted playsInline preload="auto" aria-hidden="true" />
        )}
        <video
          ref={fg}
          className="stage-fg"
          src={src}
          playsInline
          preload="auto"
          muted={settings.audio.mute}
          onTimeUpdate={onTimeUpdate}
          onSeeked={onTimeUpdate}
          onPlay={syncBackground}
          onPause={syncBackground}
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = settings.trim.start
          }}
          style={{
            left: pct(layout.left, out.width),
            top: pct(layout.top, out.height),
            width: pct(layout.width, out.width),
            height: pct(layout.height, out.height)
          }}
          data-testid="editor-video"
        />
        <canvas ref={canvas} className="stage-text" data-testid="editor-text-layer" />
        {safeArea !== 'none' && settings.output.preset === '9:16' && (
          <div className="safe-areas" aria-hidden="true">
            {SAFE_AREAS[safeArea].zones.map((z, i) => (
              <span
                key={i}
                className="safe-zone"
                style={{ left: pct(z.x, 1), top: pct(z.y, 1), width: pct(z.w, 1), height: pct(z.h, 1) }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
