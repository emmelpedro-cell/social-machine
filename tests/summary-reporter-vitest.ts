import type { Reporter } from 'vitest/reporters'

type TaskLike = { type: string; name: string; result?: { state?: string }; mode?: string; tasks?: TaskLike[] }

/**
 * Publishes per-file test counts as a GitHub Actions notice, so a green run
 * shows what actually ran (and that nothing was silently skipped).
 */
export default class SummaryReporter implements Reporter {
  // Typed loosely on purpose: only a few stable fields of Vitest's task tree are read.
  onFinished(files: readonly unknown[] = []): void {
    if (!process.env.GITHUB_ACTIONS) return
    const totals = { pass: 0, skip: 0, fail: 0 }
    const lines: string[] = []
    for (const file of files as TaskLike[]) {
      const counts = { pass: 0, skip: 0, fail: 0 }
      const visit = (task: TaskLike) => {
        if (task.type === 'test') {
          const state = task.mode === 'skip' || task.mode === 'todo' ? 'skip' : task.result?.state === 'pass' ? 'pass' : 'fail'
          counts[state]++
          totals[state]++
        }
        task.tasks?.forEach(visit)
      }
      visit(file)
      lines.push(`${file.name}: ${counts.pass} passed, ${counts.skip} skipped, ${counts.fail} failed`)
    }
    console.log(
      `::notice title=Vitest: ${totals.pass} passed, ${totals.skip} skipped, ${totals.fail} failed::${lines.join('%0A')}`
    )
  }
}
