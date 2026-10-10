const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date)
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime()
  if (Number.isNaN(diff)) return iso
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 14) return `há ${days} d`
  return formatDateTime(iso)
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
