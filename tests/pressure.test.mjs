import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldPrecompact, resolveCompactionThresholdRatio } from '../lib/pressure.js'

test('shouldPrecompact fires at proximity * threshold * window', () => {
  const config = { proximityRatio: 0.8, compactionThresholdRatio: 0.8 }
  assert.equal(shouldPrecompact({ pressure: { projectedTokens: 640, contextWindow: 1000 }, config: config }), true)
  assert.equal(shouldPrecompact({ pressure: { projectedTokens: 639, contextWindow: 1000 }, config: config }), false)
  assert.equal(shouldPrecompact({ pressure: { projectedTokens: 1200, contextWindow: 1000 }, config: { proximityRatio: 0.5, compactionThresholdRatio: 1 } }), true)
})

test('shouldPrecompact falls back to absolute tokens without a window', () => {
  const config = { fallbackTriggerTokens: 100 }
  assert.equal(shouldPrecompact({ pressure: { projectedTokens: 150 }, config: config }), true)
  assert.equal(shouldPrecompact({ pressure: { pressureTokens: 50 }, config: config }), false)
})

test('resolveCompactionThresholdRatio reads the compaction-basic loader entry', () => {
  const ctx = { get: (k) => k === 'loader' ? { entries: () => [{ name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0.7 } }] } : undefined }
  assert.equal(resolveCompactionThresholdRatio(ctx, 0.8), 0.7)
  assert.equal(resolveCompactionThresholdRatio({}, 0.55), 0.55)
})
