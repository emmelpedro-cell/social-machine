import { pathToFileURL } from 'node:url'

/**
 * Decides whether an IPC message comes from our own renderer page.
 * In development that is the Vite dev server URL; in production it is the
 * bundled index.html loaded from disk. Anything else (a navigated-away page,
 * an injected iframe) is rejected before the handler runs.
 */
export function createSenderValidator(options: { devServerUrl?: string; rendererIndexPath: string }) {
  const devOrigin = options.devServerUrl ? new URL(options.devServerUrl).origin : null
  const indexUrl = pathToFileURL(options.rendererIndexPath).href

  return function isTrustedSender(frameUrl: string | undefined | null): boolean {
    if (!frameUrl) return false
    let url: URL
    try {
      url = new URL(frameUrl)
    } catch {
      return false
    }
    if (devOrigin && url.origin === devOrigin) return true
    if (url.protocol === 'file:') {
      const withoutHash = frameUrl.split('#')[0]?.split('?')[0]
      return withoutHash === indexUrl
    }
    return false
  }
}
