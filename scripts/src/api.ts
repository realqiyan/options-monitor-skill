// API Calls - Wrap mcporter CLI commands

import { execSync } from 'child_process'
import {
  Strategy,
  StrategyDetail,
  OptionsRealtimeData,
} from './types.js'

/**
 * Execute mcporter CLI command
 */
function callApi(tool: string, params: Record<string, string> = {}): unknown {
  const paramStr = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')

  const cmd = `mcporter call options-trade.${tool} ${paramStr}`.trim()

  try {
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return JSON.parse(result)
  } catch (error) {
    throw new Error(`API call failed: ${tool} - ${error}`)
  }
}

/**
 * Fetch all strategies
 */
export async function fetchAllStrategies(): Promise<Strategy[]> {
  const response = callApi('queryAllStrategy') as { data: Strategy[] }
  return response.data || []
}

/**
 * Fetch strategy detail with orders
 */
export async function fetchStrategyDetail(strategyId: string): Promise<StrategyDetail> {
  return callApi('queryStrategyDetailAndOrders', { strategyId }) as StrategyDetail
}

/**
 * Fetch options realtime data
 */
export async function fetchOptionsRealtime(code: string): Promise<OptionsRealtimeData | null> {
  try {
    return callApi('queryOptionsRealtimeData', { code }) as OptionsRealtimeData
  } catch {
    return null
  }
}

/**
 * Fetch realtime prices for multiple options
 */
export async function fetchOptionsRealtimePrices(
  codes: string[]
): Promise<Map<string, OptionsRealtimeData>> {
  const result = new Map<string, OptionsRealtimeData>()

  for (const code of codes) {
    const data = await fetchOptionsRealtime(code)
    if (data) {
      result.set(code, data)
    }
  }

  return result
}