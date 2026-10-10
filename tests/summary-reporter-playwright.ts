import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'

/**
 * Publishes a per-test summary as a GitHub Actions notice, so a green run
 * shows what actually ran (and that nothing was silently skipped).
 */
export default class SummaryReporter implements Reporter {
  private readonly lines: string[] = []
  private readonly counts = { passed: 0, skipped: 0, failed: 0 }

  onTestEnd(test: TestCase, result: TestResult): void {
    const outcome = result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed'
    this.counts[outcome]++
    const project = test.parent.project()?.name ?? ''
    this.lines.push(`${outcome.toUpperCase()} [${project}] ${test.title} (${Math.round(result.duration / 100) / 10} s)`)
  }

  onEnd(result: FullResult): void {
    if (!process.env.GITHUB_ACTIONS) return
    const { passed, skipped, failed } = this.counts
    const body = this.lines.join('%0A')
    console.log(`::notice title=Playwright ${result.status}: ${passed} passed, ${skipped} skipped, ${failed} failed::${body}`)
  }
}
