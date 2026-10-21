/**
 * Preset mounting with a cross-version id alias: dsh renamed the `code` preset
 * to `ptc` in 0.2.x. Try the requested id first, then its alias — but only when
 * the failure is an unknown-preset error (the registry retains the id before
 * binding, so a not-found leaves nothing half-bound).
 * @module @deepseek-ai/dsh-workflow-engine/preset-mount
 */

import type { Context } from '@deepseek-ai/cordis'

/** Minimal `agentPresets` service surface (mount by id, undefined = default). */
export interface AgentPresetsLike {
  mount(ctx: Context, id?: string): Promise<unknown>
}

const PRESET_ALIASES: Record<string, string> = { code: 'ptc', ptc: 'code' }

/** Whether a mount failure is the registry's unknown-preset error. */
export function isPresetNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null
  return e?.code === 'agent-preset/not-found'
    || (typeof e?.message === 'string' && e.message.includes('Unknown agent preset'))
}

/** Mount the requested preset, retrying once under its cross-version alias. */
export async function mountPreset(presets: AgentPresetsLike, agentCtx: Context, id: string | undefined): Promise<void> {
  try {
    await presets.mount(agentCtx, id)
  } catch (error) {
    const alias = id === undefined ? undefined : PRESET_ALIASES[id]
    if (alias === undefined || !isPresetNotFound(error)) throw error
    await presets.mount(agentCtx, alias)
  }
}
