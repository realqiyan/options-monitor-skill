// Strategy rules analysis module

import {
  StrategyStatus,
  OptionPosition,
  DeltaAnalysis,
  PositionAdjustmentAlert,
} from './types.js'

/**
 * CC Strategy (Covered Call) Delta Analysis
 *
 * Rules:
 * - Normal delta range: 0.25 - 0.75
 * - Trigger adjustment: delta <= 0.25 or >= 0.75
 * - Trigger adjustment: DTE <= 21 days (3 weeks)
 * - Adjustment target when delta >= 0.75: 0.5
 * - Adjustment target when delta <= 0.25: max(current + 0.1, 0.35)
 * - Adjustment target when DTE <= 21 and delta in range: move 0.1 toward 0.5
 */
function analyzeCCStrategyDelta(
  currentDelta: number,
  minDTE: number
): DeltaAnalysis {
  const WEEKS_3_DAYS = 21

  // Check if expiration warning
  if (minDTE <= WEEKS_3_DAYS) {
    if (currentDelta > 0.25 && currentDelta < 0.75) {
      // Delta in range but approaching expiration
      const targetDelta = currentDelta > 0.5
        ? currentDelta - 0.1
        : currentDelta + 0.1
      return {
        strategyCode: 'cc_strategy',
        currentDelta,
        targetDelta: Math.round(targetDelta * 100) / 100,
        needsAdjustment: true,
        reason: `DTE=${minDTE}天<=3周，需调整delta向0.5靠近`,
      }
    }
  }

  // Check delta bounds
  if (currentDelta >= 0.75) {
    return {
      strategyCode: 'cc_strategy',
      currentDelta,
      targetDelta: 0.5,
      needsAdjustment: true,
      reason: `Delta=${currentDelta.toFixed(2)}>=0.75，需向下调整至0.5`,
    }
  }

  if (currentDelta <= 0.25) {
    const targetDelta = Math.max(currentDelta + 0.1, 0.35)
    return {
      strategyCode: 'cc_strategy',
      currentDelta,
      targetDelta: Math.round(targetDelta * 100) / 100,
      needsAdjustment: true,
      reason: `Delta=${currentDelta.toFixed(2)}<=0.25，需向上调整至${targetDelta.toFixed(2)}`,
    }
  }

  // Check expiration only
  if (minDTE <= WEEKS_3_DAYS) {
    return {
      strategyCode: 'cc_strategy',
      currentDelta,
      targetDelta: null,
      needsAdjustment: true,
      reason: `DTE=${minDTE}天<=3周，需考虑展期`,
    }
  }

  return {
    strategyCode: 'cc_strategy',
    currentDelta,
    targetDelta: null,
    needsAdjustment: false,
    reason: `Delta在正常区间(0.25-0.75)`,
  }
}

/**
 * Wheel Strategy Delta Analysis
 *
 * Rules:
 * - SELL PUT: delta 0.10-0.35 for opening
 * - SELL PUT: take profit when profit >= 80%
 * - SELL PUT: accept assignment when stock price <= strike price
 * - SELL CALL: strike price >= purchase price
 * - During holding: don't focus on delta
 */
function analyzeWheelStrategyDelta(
  currentDelta: number,
  holdStockNum: number
): DeltaAnalysis {
  // Wheel strategy doesn't monitor delta during holding
  // But we can provide guidance for position status
  if (holdStockNum === 0) {
    // Holding cash, should be selling PUT
    if (currentDelta > 0.35) {
      return {
        strategyCode: 'wheel_strategy',
        currentDelta,
        targetDelta: null,
        needsAdjustment: false,
        reason: `当前持股=0，开仓卖Put建议Delta 0.10-0.35`,
      }
    }
  } else {
    // Holding stock, should be selling CALL
    return {
      strategyCode: 'wheel_strategy',
      currentDelta,
      targetDelta: null,
      needsAdjustment: false,
      reason: `持有股票${holdStockNum}股，卖Call策略`,
    }
  }

  return {
    strategyCode: 'wheel_strategy',
    currentDelta,
    targetDelta: null,
    needsAdjustment: false,
    reason: `Delta在正常状态`,
  }
}

/**
 * Default Strategy Delta Analysis
 *
 * Rules:
 * - Only sell options
 * - Delta range: 0.15 - 0.35
 * - Prefer weekly options
 */
function analyzeDefaultStrategyDelta(
  currentDelta: number
): DeltaAnalysis {
  if (currentDelta < 0.15) {
    return {
      strategyCode: 'default',
      currentDelta,
      targetDelta: null,
      needsAdjustment: false,
      reason: `Delta=${currentDelta.toFixed(2)}<0.15，卖期权建议Delta 0.15-0.35`,
    }
  }

  if (currentDelta > 0.35) {
    return {
      strategyCode: 'default',
      currentDelta,
      targetDelta: null,
      needsAdjustment: false,
      reason: `Delta=${currentDelta.toFixed(2)}>0.35，卖期权建议Delta 0.15-0.35`,
    }
  }

  return {
    strategyCode: 'default',
    currentDelta,
    targetDelta: null,
    needsAdjustment: false,
    reason: `Delta在正常区间(0.15-0.35)`,
  }
}

/**
 * Analyze delta for any strategy
 */
export function analyzeDeltaForStrategy(
  strategyCode: string,
  normalizedDelta: number,
  minDTE: number,
  holdStockNum: number
): DeltaAnalysis {
  switch (strategyCode) {
    case 'cc_strategy':
      return analyzeCCStrategyDelta(normalizedDelta, minDTE)
    case 'wheel_strategy':
      return analyzeWheelStrategyDelta(normalizedDelta, holdStockNum)
    case 'default':
      return analyzeDefaultStrategyDelta(normalizedDelta)
    default:
      return {
        strategyCode,
        currentDelta: normalizedDelta,
        targetDelta: null,
        needsAdjustment: false,
        reason: `未知策略类型`,
      }
  }
}

/**
 * Calculate PnL percentage for an option position
 */
function calculatePnL(option: OptionPosition): number {
  if (option.costPrice <= 0) return 0

  if (option.direction === 'SELL') {
    // Sell option: profit when price drops
    return ((option.costPrice - option.currentPrice) / option.costPrice) * 100
  } else {
    // Buy option: profit when price rises
    return ((option.currentPrice - option.costPrice) / option.costPrice) * 100
  }
}

/**
 * Check if option is ITM (In-The-Money)
 */
function isITM(option: OptionPosition, stockPrice: number): boolean {
  if (option.isCall) {
    return stockPrice > option.strikePrice
  } else {
    return stockPrice < option.strikePrice
  }
}

/**
 * Check position adjustment alerts for Wheel strategy
 *
 * Rules:
 * - SELL PUT: take profit when profit >= 80%
 * - SELL PUT: assignment risk when ITM
 */
function checkWheelStrategyAdjustments(
  strategyId: string,
  strategyName: string,
  status: StrategyStatus
): PositionAdjustmentAlert[] {
  const alerts: PositionAdjustmentAlert[] = []

  for (const option of status.options) {
    const pnl = calculatePnL(option)
    const itm = isITM(option, status.stockPrice)

    // SELL PUT profit take
    if (option.direction === 'SELL' && !option.isCall) {
      if (pnl >= 80) {
        alerts.push({
          strategyId,
          strategyName,
          strategyCode: 'wheel_strategy',
          type: 'PUT_PROFIT_TAKE',
          message: `卖Put收益${pnl.toFixed(1)}%>=80%，建议平仓`,
          details: {
            code: option.code,
            pnl,
            strikePrice: option.strikePrice,
          },
        })
      }

      // Assignment risk for ITM PUT
      if (itm) {
        alerts.push({
          strategyId,
          strategyName,
          strategyCode: 'wheel_strategy',
          type: 'ASSIGNMENT_RISK',
          message: `卖Put已价内(ITM)，存在被指派接股风险`,
          details: {
            code: option.code,
            strikePrice: option.strikePrice,
            stockPrice: status.stockPrice,
          },
        })
      }
    }
  }

  return alerts
}

/**
 * Check position adjustment alerts for CC strategy
 *
 * Rules:
 * - Expiration warning when DTE <= 21
 */
function checkCCStrategyAdjustments(
  strategyId: string,
  strategyName: string,
  status: StrategyStatus
): PositionAdjustmentAlert[] {
  const alerts: PositionAdjustmentAlert[] = []
  const WEEKS_3_DAYS = 21

  for (const option of status.options) {
    if (option.dte <= WEEKS_3_DAYS) {
      alerts.push({
        strategyId,
        strategyName,
        strategyCode: 'cc_strategy',
        type: 'EXPIRATION_WARNING',
        message: `期权DTE=${option.dte}天<=3周，需考虑展期或平仓`,
        details: {
          code: option.code,
          dte: option.dte,
          strikePrice: option.strikePrice,
        },
      })
    }
  }

  return alerts
}

/**
 * Check position adjustments for a strategy
 */
export function checkPositionAdjustments(
  strategyId: string,
  strategyName: string,
  strategyCode: string,
  status: StrategyStatus
): PositionAdjustmentAlert[] {
  switch (strategyCode) {
    case 'wheel_strategy':
      return checkWheelStrategyAdjustments(strategyId, strategyName, status)
    case 'cc_strategy':
      return checkCCStrategyAdjustments(strategyId, strategyName, status)
    default:
      return []
  }
}

/**
 * Get minimum DTE from all options
 */
export function getMinDTE(options: OptionPosition[]): number {
  if (options.length === 0) return 999
  return Math.min(...options.map(o => o.dte))
}