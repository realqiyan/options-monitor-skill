// Report generation - output JSON and console

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  MonitoringReport,
  StrategyStatus,
  StopLossAlert,
  OptionPosition,
  Strategy,
  StrategyDetailResponse,
  PositionAdjustmentAlert,
  STOP_LOSS_THRESHOLDS,
} from './types.js'
import {
  analyzeDeltaForStrategy,
  checkPositionAdjustments,
  getMinDTE,
} from './rules.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const OUTPUT_DIR = join(__dirname, '..', 'output')

function getOutputFile(): string {
  return join(OUTPUT_DIR, 'latest-report.txt')
}

/**
 * Check if an option is In-The-Money
 */
export function isITM(option: OptionPosition, stockPrice: number): boolean {
  if (option.isCall) {
    // Call: stock price > strike price = ITM
    return stockPrice > option.strikePrice
  } else {
    // Put: stock price < strike price = ITM
    return stockPrice < option.strikePrice
  }
}

/**
 * Calculate PnL percentage for an option position
 * - Buy options: price up = profit
 * - Sell options: price down = profit (received premium > buyback cost)
 */
export function calculatePnL(option: OptionPosition): number {
  if (option.costPrice <= 0) return 0

  if (option.direction === 'SELL') {
    // Sell option: received premium is costPrice, currentPrice is buyback cost
    // Price dropping = profit (can buy back cheaper)
    return ((option.costPrice - option.currentPrice) / option.costPrice) * 100
  } else {
    // Buy option: price rising = profit
    return ((option.currentPrice - option.costPrice) / option.costPrice) * 100
  }
}

/**
 * Generate diagnostic tips for an option position
 */
export function generateOptionDiagnostics(
  option: OptionPosition,
  stockPrice: number
): string[] {
  const tips: string[] = []

  // 1. PnL
  const pnl = calculatePnL(option)
  const pnlSign = pnl >= 0 ? '+' : ''

  // 2. ITM/OTM status
  const itm = isITM(option, stockPrice)
  const itmStatus = itm ? '价内(ITM)' : '价外(OTM)'

  tips.push(`📈 盈亏: ${pnlSign}${pnl.toFixed(1)}% | ${itmStatus}`)

  // 3. Expiration warning
  if (option.dte <= 3) {
    tips.push(`⏰ DTE=${option.dte}，期权即将到期，需立即处理`)
  } else if (option.dte <= 7) {
    tips.push(`⏰ DTE=${option.dte}，期权即将到期，考虑平仓或展期`)
  }

  // 4. Assignment risk for sold ITM options
  if (option.direction === 'SELL' && itm) {
    tips.push(`⚠️ 卖出期权已价内，存在被行权风险`)
  }

  return tips
}

/**
 * Analyze Delta for wheel strategy (legacy - kept for compatibility)
 * @deprecated Use analyzeDeltaForStrategy from rules.ts instead
 */
export function analyzeDelta(
  normalizedDelta: number,
  strategyCode: string,
  holdStockNum: number
): string | null {
  // Wheel strategy: target Delta 0.3-0.5
  if (strategyCode === 'wheel_strategy') {
    if (holdStockNum === 0) {
      // Holding cash, selling Put, prefer lower Delta
      if (normalizedDelta > 0.3) {
        return `💡 Delta=${normalizedDelta.toFixed(2)} 偏高，卖Put策略建议 Delta < 0.3`
      }
    } else {
      // Holding stock, selling Call
      if (normalizedDelta < 0.5) {
        return `💡 Delta=${normalizedDelta.toFixed(2)} 偏低，卖Call策略建议 Delta > 0.5`
      }
    }
  }
  return null
}

/**
 * Get delta analysis message for report
 */
export function getDeltaAnalysisMessage(
  strategyCode: string,
  normalizedDelta: number,
  minDTE: number,
  holdStockNum: number
): string | null {
  const analysis = analyzeDeltaForStrategy(strategyCode, normalizedDelta, minDTE, holdStockNum)
  if (analysis.needsAdjustment || analysis.reason) {
    return `💡 ${analysis.reason}`
  }
  return null
}

/**
 * Calculate DTE (Days To Expiration)
 */
export function calculateDTE(strikeTime: string): number {
  const expiration = new Date(strikeTime)
  const now = new Date()
  const diffMs = expiration.getTime() - now.getTime()
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)))
}

/**
 * Check stop loss for an option position
 * Returns alert if triggered, null otherwise
 */
export function checkStopLoss(
  strategyId: string,
  strategyName: string,
  position: OptionPosition
): StopLossAlert | null {
  const { direction, currentPrice, costPrice, code } = position

  if (costPrice <= 0 || currentPrice <= 0) {
    return null
  }

  const changePercent = ((currentPrice - costPrice) / costPrice) * 100

  // Buy option: loss if price drops significantly
  if (direction === 'BUY') {
    if (changePercent <= -STOP_LOSS_THRESHOLDS.BUY_OPTION_LOSS_PERCENT) {
      return {
        strategyId,
        strategyName,
        orderCode: code,
        type: 'BUY_STOP_LOSS',
        message: `买入期权价格下跌 ${Math.abs(changePercent).toFixed(1)}%，触发止损告警`,
        currentPrice,
        costPrice,
        changePercent,
      }
    }
  }

  // Sell option: loss if price rises significantly
  if (direction === 'SELL') {
    if (changePercent >= STOP_LOSS_THRESHOLDS.SELL_OPTION_GAIN_PERCENT) {
      return {
        strategyId,
        strategyName,
        orderCode: code,
        type: 'SELL_STOP_LOSS',
        message: `卖出期权价格上涨 ${changePercent.toFixed(1)}%，触发止损告警`,
        currentPrice,
        costPrice,
        changePercent,
      }
    }
  }

  return null
}

/**
 * Build option position from order data
 * Uses orderGroups to calculate cost price
 */
export function buildOptionPositionFromOrder(
  order: StrategyDetailResponse['orders'][0],
  orderGroups: Record<string, { totalIncome: number; totalOrderFee: number; orderCount: number }>
): OptionPosition | null {
  // Skip closed orders
  if (order.ext?.isClose === 'true') {
    return null
  }

  // Skip stock orders
  if (order.ext?.codeType === 'STOCK') {
    return null
  }

  // Side: 1=buy, 2=sell, 3=sell to open, 4=buy to close
  // For simplicity: 2 or 3 = SELL (sell to open), 1 or 4 = BUY
  const direction = order.side === 2 || order.side === 3 ? 'SELL' : 'BUY'

  // Get order group info for cost calculation
  const groupInfo = orderGroups[order.groupId]
  const avgPrice = groupInfo && groupInfo.orderCount > 0
    ? Math.abs(groupInfo.totalIncome) / (order.quantity * 100) // Approximate per-contract price
    : order.price

  // Use ext data for option info
  const isCall = order.ext?.codeType === 'CALL'
  const isPut = order.ext?.codeType === 'PUT' || order.ext?.isPut === 'true'
  const strikePrice = order.ext?.strikePrice ? parseFloat(order.ext.strikePrice) : 0

  // Use curDTE from ext if available, otherwise calculate
  let dte: number
  if (order.ext?.curDTE !== undefined) {
    dte = parseInt(order.ext.curDTE)
  } else {
    dte = calculateDTE(order.strikeTime)
  }

  return {
    code: order.code,
    direction,
    contracts: order.quantity,
    delta: 0,
    theta: 0,
    dte,
    currentPrice: avgPrice, // Will be updated if we have position data
    costPrice: avgPrice,
    strikePrice,
    isCall: isCall || (!isPut && order.code.includes('C') && !order.code.includes('P')),
    status: 0,
  }
}

/**
 * Build strategy status from detail response
 */
export function buildStrategyStatus(
  strategy: Strategy,
  detail: StrategyDetailResponse
): StrategyStatus {
  const summary = detail.summary
  const strategyData = detail.data

  // Build option positions from strategy's open orders
  const options: OptionPosition[] = []
  const seenCodes = new Set<string>()

  for (const order of detail.orders) {
    // Skip already seen codes (deduplicate)
    if (seenCodes.has(order.code)) continue
    seenCodes.add(order.code)

    const optPos = buildOptionPositionFromOrder(order, detail.orderGroups)
    if (optPos) {
      options.push(optPos)
    }
  }

  return {
    strategyId: strategyData.strategyId,
    strategyName: strategyData.strategyName,
    strategyCode: strategyData.strategyCode,
    stockCode: strategyData.code,
    stockPrice: summary.currentStockPrice,
    holdStockNum: summary.holdStockNum,
    lotSize: strategyData.lotSize,
    normalizedDelta: summary.avgDelta,
    optionsDelta: summary.optionsDelta,
    optionsTheta: summary.optionsTheta,
    openOptionsQuantity: summary.openOptionsQuantity,
    options,
    allOptionsIncome: summary.allOptionsIncome,
    allIncome: summary.allIncome,
  }
}

/**
 * Generate monitoring report
 */
export function generateReport(
  strategies: StrategyStatus[],
  alerts: StopLossAlert[],
  adjustmentAlerts: PositionAdjustmentAlert[],
  noOptionsPositions: string[],
  fetchErrors: string[]
): MonitoringReport {
  return {
    generatedAt: new Date().toISOString(),
    strategies,
    alerts,
    adjustmentAlerts,
    noOptionsPositions,
    fetchErrors,
  }
}

/**
 * Format report as text (same as console output)
 */
export function formatReportAsText(report: MonitoringReport): string {
  const lines: string[] = []

  // Print alerts first
  if (report.alerts.length > 0) {
    lines.push('\n⚠️  止损告警:')
    for (const alert of report.alerts) {
      lines.push(`  [${alert.strategyName}] ${alert.orderCode}`)
      lines.push(`    ${alert.message}`)
      lines.push(`    成本价: ${alert.costPrice}, 当前价: ${alert.currentPrice}`)
    }
  }

  // Print adjustment alerts
  if (report.adjustmentAlerts.length > 0) {
    lines.push('\n📋 持仓调整建议:')
    for (const alert of report.adjustmentAlerts) {
      lines.push(`  [${alert.strategyName}] ${alert.details.code || ''}`)
      lines.push(`    ${alert.message}`)
    }
  }

  // Print strategies
  lines.push(`\n📊 需要Agent继续分析的${report.strategies.length}个期权交易策略:`)
  for (const strategy of report.strategies) {
    lines.push(`\n  ${strategy.strategyName} (${strategy.strategyCode})`)
    lines.push(`    策略ID: ${strategy.strategyId}`)
    lines.push(`    标的: ${strategy.stockCode} @ ${strategy.stockPrice.toFixed(2)}`)
    lines.push(`    Delta: 策略 ${strategy.normalizedDelta.toFixed(2)}, 期权 ${strategy.optionsDelta.toFixed(2)}`)

    // Delta analysis with rules
    const minDTE = getMinDTE(strategy.options)
    const deltaMsg = getDeltaAnalysisMessage(
      strategy.strategyCode,
      strategy.normalizedDelta,
      minDTE,
      strategy.holdStockNum
    )
    if (deltaMsg) {
      lines.push(`    ${deltaMsg}`)
    }

    lines.push(`    Theta: ${strategy.optionsTheta.toFixed(4)}`)
    lines.push(`    持股: ${strategy.holdStockNum}, 手数: ${strategy.lotSize}, 期权: ${strategy.openOptionsQuantity}`)
    lines.push(`    累计收益: 期权 ${strategy.allOptionsIncome.toFixed(2)}, 总计 ${strategy.allIncome.toFixed(2)}`)

    if (strategy.options.length > 0) {
      lines.push(`    期权持仓:`)
      for (const opt of strategy.options) {
        const direction = opt.direction === 'SELL' ? '卖' : '买'
        const type = opt.isCall ? 'Call' : 'Put'
        lines.push(`      ${opt.code} (${direction}${type}) x${opt.contracts}`)
        lines.push(`        行权价: ${opt.strikePrice} | DTE: ${opt.dte} | 成本: ${opt.costPrice} | 现价: ${opt.currentPrice}`)
        // Add diagnostic tips
        const diagnostics = generateOptionDiagnostics(opt, strategy.stockPrice)
        for (const tip of diagnostics) {
          lines.push(`        ${tip}`)
        }
      }
    }
  }

  // Print strategies without options
  if (report.noOptionsPositions.length > 0) {
    lines.push('\n📭 无期权持仓的策略:')
    for (const strategyId of report.noOptionsPositions) {
      const strategy = report.strategies.find((s) => s.strategyId === strategyId)
      if (strategy) {
        lines.push(`  ${strategy.strategyName} (${strategy.stockCode})`)
      }
    }
  }

  // Print errors
  if (report.fetchErrors.length > 0) {
    lines.push('\n❌ 错误:')
    for (const error of report.fetchErrors) {
      lines.push(`  ${error}`)
    }
  }

  lines.push('')

  return lines.join('\n')
}

/**
 * Write report to text file
 */
export function writeReportToFile(report: MonitoringReport): void {
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  const outputFile = getOutputFile()
  const content = formatReportAsText(report)
  writeFileSync(outputFile, content, 'utf-8')
  console.log(`\nReport saved to: ${outputFile}`)
}

/**
 * Print report summary to console
 */
export function printReportSummary(report: MonitoringReport): void {
  console.log(formatReportAsText(report))
}