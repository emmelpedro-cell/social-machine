/// <reference types="vite/client" />
import type { SmApi } from '../../shared/api'

declare global {
  interface Window {
    sm: SmApi
  }
}

export {}
