const RUNTIME_FALLBACK_CONTINUATION_MARKER = "[runtime-fallback-continuation]"

export function extractRuntimeFallbackContinuationSystem(system: string | undefined): string | undefined {
  if (!system) return undefined
  const markerIndex = system.indexOf(RUNTIME_FALLBACK_CONTINUATION_MARKER)
  if (markerIndex === -1) return undefined
  const continuation = system.slice(markerIndex).trim()
  return continuation.length > 0 ? continuation : undefined
}

export function stripRuntimeFallbackContinuationSystem(system: string | undefined): string | undefined {
  if (!system) return undefined
  const markerIndex = system.indexOf(RUNTIME_FALLBACK_CONTINUATION_MARKER)
  const cleaned = (markerIndex === -1 ? system : system.slice(0, markerIndex)).trimEnd()
  return cleaned.length > 0 ? cleaned : undefined
}
