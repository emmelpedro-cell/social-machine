import type { SmApi } from '../../src/shared/api'

// The preload exposes this in the app window; page.evaluate callbacks run there.
declare global {
  interface Window {
    sm: SmApi
  }
}

export {}
