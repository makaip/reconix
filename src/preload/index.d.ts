import type { ReconixApi } from './index'

declare global {
  interface Window {
    reconix: ReconixApi
  }
}
