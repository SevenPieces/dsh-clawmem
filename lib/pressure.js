const DEFAULT_PROXIMITY = 0.8
const DEFAULT_MIRROR = 0.8
const DEFAULT_FALLBACK_TOKENS = 100000

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function shouldPrecompact(input) {
  const args = input || {}
  const pressure = args.pressure || {}
  const config = args.config || {}
  const proximity = num(config.proximityRatio)
  const mirror = num(config.compactionThresholdRatio)
  const ratio = (proximity === undefined ? DEFAULT_PROXIMITY : proximity) * (mirror === undefined ? DEFAULT_MIRROR : mirror)
  const projected = num(pressure.projectedTokens)
  const window = num(pressure.contextWindow)
  if (projected !== undefined && window !== undefined && window > 0) return projected + 1e-6 >= ratio * window
  const fallback = num(config.fallbackTriggerTokens)
  const floor = fallback === undefined ? DEFAULT_FALLBACK_TOKENS : fallback
  if (projected !== undefined) return projected >= floor
  const current = num(pressure.pressureTokens)
  if (current !== undefined) return current >= floor
  return false
}

export function resolveCompactionThresholdRatio(ctx, mirror) {
  const mirrored = num(mirror)
  const fallback = mirrored === undefined ? DEFAULT_MIRROR : mirrored
  try {
    const loader = ctx && typeof ctx.get === 'function' ? ctx.get('loader') : undefined
    const entries = loader && typeof loader.entries === 'function' ? loader.entries() : []
    for (const entry of entries) {
      if (!entry) continue
      const entryName = entry.name || (entry.options && entry.options.name)
      if (entryName !== '@deepseek-ai/dsh-compaction-basic') continue
      const entryConfig = entry.config || (entry.options && entry.options.config)
      const ratio = entryConfig ? num(entryConfig.thresholdRatio) : undefined
      if (ratio !== undefined) return ratio
    }
  } catch { /* best-effort */ }
  return fallback
}
