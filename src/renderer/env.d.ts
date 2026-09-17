import type { PcManagerApi } from '../shared/types.js'

declare global {
  interface Window {
    pcManager: PcManagerApi
  }
}

export {}
