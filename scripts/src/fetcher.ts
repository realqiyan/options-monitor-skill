// Data fetcher - wraps mcporter CLI calls

import { execSync } from 'child_process'
import {
  AllStrategyResponse,
  StrategyDetailResponse,
  AllPositionResponse,
  StockPriceResponse,
  Strategy,
  Position,
} from './types.js'

/**
 * Execute mcporter command and parse JSON output
 */
function executeMcporter(toolName: string, params: Record<string, string | number> = {}): unknown {
  const paramStr = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')

  const command = `mcporter call options-trade.${toolName} ${paramStr}`.trim()

  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 30000,
    })
    return JSON.parse(output)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to execute ${toolName}: ${errorMessage}`)
  }
}

/**
 * Fetch all strategies
 */
export async function fetchAllStrategies(): Promise<Strategy[]> {
  const response = executeMcporter('queryAllStrategy') as AllStrategyResponse
  return response.allStrategy || []
}

/**
 * Fetch strategy detail and orders
 */
export async function fetchStrategyDetailAndOrders(
  strategyId: string
): Promise<StrategyDetailResponse> {
  return executeMcporter('queryStrategyDetailAndOrders', { strategyId }) as StrategyDetailResponse
}

/**
 * Fetch all positions
 */
export async function fetchAllPositions(): Promise<Position[]> {
  const response = executeMcporter('queryAllPosition') as AllPositionResponse
  return response.positions || []
}

/**
 * Fetch stock real-time price
 */
export async function fetchStockPrice(code: string, market: number): Promise<number> {
  try {
    const response = executeMcporter('queryStockRealPrice', { code, market }) as StockPriceResponse
    return response.price || 0
  } catch {
    return 0
  }
}

/**
 * Get market code from strategy
 */
export function getMarketCode(strategy: Strategy): number {
  // All strategies are US stocks based on the data
  return 11
}