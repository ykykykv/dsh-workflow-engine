/**
 * Platform-contributed session events this plugin appends. They are declared by
 * the deployment's sandbox-policy / user-approval seams at runtime; declaring
 * them here keeps `Session.append` type-checked without importing those seam
 * packages (which stay optional for consumers).
 * @module @deepseek-ai/dsh-workflow-engine/dsh-events
 */

import '@deepseek-ai/dsh-session/types'
import type { SandboxMode } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable sandbox-mode override; `source: 'delegation'` marks a seeded child. */
    'sandbox/mode': {
      mode: SandboxMode
      source?: 'delegation'
    }
    /** Durable approval-policy override; `source: 'delegation'` marks a seeded child. */
    'approval/policy': {
      policy: 'ask' | 'never'
      source?: 'delegation'
    }
  }
}
