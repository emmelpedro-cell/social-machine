import type { Project } from '../../../shared/schemas'

type Props = {
  projects: Project[]
  value: string | null
  onChange: (projectId: string | null) => void
  label: string
  noneLabel?: string
  testId?: string
  disabled?: boolean
}

/** Project picker with an explicit "no project" choice. */
export function ProjectSelect({ projects, value, onChange, label, noneLabel = 'Sem projeto', testId, disabled }: Props) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
    >
      <option value="">{noneLabel}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}
