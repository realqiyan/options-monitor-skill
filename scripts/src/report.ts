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
  RiskLevel,
  PortfolioPnL,
  StrategyWithRisk,
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
 * Calculate portfolio PnL (stock + options)
 * 组合盈亏计算：股票盈亏 + 期权盈亏
 */
export function calculatePortfolioPnL(
  holdStockNum: number,
  holdStockCost: number,
  stockPrice: number,
  options: OptionPosition[]
): PortfolioPnL {
  // 股票盈亏 = (现价 - 成本价) × 持股数
  const stockCost = holdStockCost * holdStockNum
  const stockValue = stockPrice * holdStockNum
  const stockPnL = stockValue - stockCost
  const stockPnLPercent = stockCost > 0 ? (stockPnL / stockCost) * 100 : 0

  // 期权盈亏 = 对每个期权计算
  let optionPnL = 0
  for (const opt of options) {
    if (opt.direction === 'SELL') {
      // 卖期权：权利金收入 - 回购成本
      optionPnL += (opt.costPrice - opt.currentPrice) * opt.contracts * 100
    } else {
      // 买期权：现值 - 成本
      optionPnL += (opt.currentPrice - opt.costPrice) * opt.contracts * 100
    }
  }

  // 组合总盈亏
  const totalCost = stockCost > 0 ? stockCost : 1 // 避免除以0
  const totalPnL = stockPnL + optionPnL
  const totalPnLPercent = (totalPnL / totalCost) * 100

  return {
    stockPnL,
    stockPnLPercent,
    optionPnL,
    totalPnL,
    totalPnLPercent,
  }
}

/**
 * Assess risk level for a strategy
 * 三级风险评估：高风险/中风险/低风险
 */
export function assessRiskLevel(
  strategyCode: string,
  holdStockNum: number,
  options: OptionPosition[],
  stockPrice: number,
  portfolioPnL?: PortfolioPnL
): { level: RiskLevel; reason: string } {
  // 1. 检查单边卖Put ITM（高风险）
  if (holdStockNum === 0) {
    const soldPut = options.find(o => o.direction === 'SELL' && !o.isCall)
    if (soldPut && isITM(soldPut, stockPrice)) {
      return { level: 'HIGH', reason: '卖Put价内(ITM)，存在被指派接股风险' }
    }
  }

  // 2. 检查组合盈亏
  if (portfolioPnL && portfolioPnL.totalPnLPercent < -20) {
    return { level: 'HIGH', reason: `组合亏损${portfolioPnL.totalPnLPercent.toFixed(1)}%，超过20%阈值` }
  }

  // 3. 检查DTE紧迫性（中风险）
  const minDTE = options.length > 0 ? Math.min(...options.map(o => o.dte)) : 999
  if (minDTE <= 7) {
    return { level: 'MEDIUM', reason: `期权即将到期(DTE=${minDTE}天)` }
  }

  // 4. 检查对冲策略
  if (holdStockNum > 0 && strategyCode === 'wheel_strategy') {
    const soldCall = options.find(o => o.direction === 'SELL' && o.isCall)
    if (soldCall) {
      if (portfolioPnL && portfolioPnL.totalPnL > 0) {
        return { level: 'LOW', reason: '对冲策略正常运行，组合盈利' }
      }
      if (!isITM(soldCall, stockPrice)) {
        return { level: 'LOW', reason: '对冲策略正常运行，卖Call价外' }
      }
    }
  }

  // 5. 默认低风险
  return { level: 'LOW', reason: '策略状态正常' }
}

/**
 * Check stop loss for an option position
 * Returns alert if triggered, null otherwise
 * 
 * 新增：对冲策略（持股+卖Call）豁免止损告警
 */
export function checkStopLoss(
  strategyId: string,
  strategyName: string,
  strategyCode: string,
  position: OptionPosition,
  holdStockNum: number
): StopLossAlert | null {
  const { direction, currentPrice, costPrice, code } = position

  if (costPrice <= 0 || currentPrice <= 0) {
    return null
  }

  const changePercent = ((currentPrice - costPrice) / costPrice) * 100

  // 新增：对冲策略豁免止损告警
  // Wheel策略/CC策略：持股+卖Call = 对冲，不单独评估期权端止损
  if (direction === 'SELL' && position.isCall && holdStockNum > 0) {
    // 对冲策略的卖Call，不触发止损告警
    return null
  }

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
  orderGroups?: Record<string, { totalIncome: number; totalOrderFee: number; orderCount: number }>
): OptionPosition | null {
  // Side: 卖出/卖空=SELL, 买入/买回=BUY
  const direction = order.side === '卖出' || order.side === '卖空' ? 'SELL' : 'BUY'

  // Calculate cost price: prefer groupTotalIncome (multi-leg strategies), fallback to orderGroups
  const avgPrice = order.groupTotalIncome != null
    ? Math.abs(order.groupTotalIncome) / (order.quantity * 100)
    : orderGroups?.[order.groupId]
      ? Math.abs(orderGroups[order.groupId].totalIncome) / (order.quantity * 100)
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
  const strategyData = detail.data ?? strategy

  // Build option positions from strategy's open orders
  const options: OptionPosition[] = []
  const codeToOrder = new Map<string, typeof detail.orders[0]>()

  // First, collect all open option orders, preferring SELL orders for same code
  for (const order of detail.orders ?? []) {
    if (order.isOpen !== '未平仓') continue
    if (order.ext?.codeType === 'STOCK') continue

    const existing = codeToOrder.get(order.code)
    // Prefer SELL orders over BUY orders for the same code
    if (!existing || order.side === '卖出' || order.side === '卖空') {
      codeToOrder.set(order.code, order)
    }
  }

  // Build option positions from collected orders
  for (const order of codeToOrder.values()) {
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
    stockPrice: summary?.currentStockPrice ?? 0,
    holdStockNum: summary?.holdStockNum ?? 0,
    lotSize: strategyData.lotSize,
    normalizedDelta: summary?.avgDelta ?? 0,
    optionsDelta: summary?.optionsDelta ?? 0,
    optionsTheta: summary?.optionsTheta ?? 0,
    openOptionsQuantity: summary?.openOptionsQuantity ?? 0,
    options,
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
  // 计算每个策略的风险等级
  const strategiesWithRisk: StrategyWithRisk[] = strategies.map(status => {
    const portfolioPnL = calculatePortfolioPnL(
      status.holdStockNum,
      0, // holdStockCost 暂时不可用
      status.stockPrice,
      status.options
    )
    const risk = assessRiskLevel(
      status.strategyCode,
      status.holdStockNum,
      status.options,
      status.stockPrice,
      portfolioPnL
    )
    return {
      status,
      riskLevel: risk.level,
      riskReason: risk.reason,
      portfolioPnL,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    strategies,
    strategiesWithRisk,
    alerts,
    adjustmentAlerts,
    noOptionsPositions,
    fetchErrors,
  }
}

/**
 * Format report as text (same as console output)
 * 优化：按风险等级分组输出
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

  // 按风险等级分组
  const highRisk = report.strategiesWithRisk.filter(s => s.riskLevel === 'HIGH')
  const mediumRisk = report.strategiesWithRisk.filter(s => s.riskLevel === 'MEDIUM')
  const lowRisk = report.strategiesWithRisk.filter(s => s.riskLevel === 'LOW')

  // 高风险策略
  if (highRisk.length > 0) {
    lines.push(`\n🔴 高风险 (${highRisk.length}个):`)
    for (const item of highRisk) {
      const strategy = item.status
      lines.push(`  ${strategy.strategyName} (${strategy.strategyCode})`)
      lines.push(`    策略ID: ${strategy.strategyId}`)
      lines.push(`    标的: ${strategy.stockCode} @ ${strategy.stockPrice.toFixed(2)}`)
      lines.push(`    风险原因: ${item.riskReason}`)
      if (item.portfolioPnL) {
        lines.push(`    组合盈亏: $${item.portfolioPnL.totalPnL.toFixed(0)} (${item.portfolioPnL.totalPnLPercent.toFixed(1)}%)`)
      }
      lines.push(`    建议: 需要立即处理`)
      // 输出期权持仓
      if (strategy.options.length > 0) {
        lines.push(`    期权持仓:`)
        for (const opt of strategy.options) {
          const direction = opt.direction === 'SELL' ? '卖' : '买'
          const type = opt.isCall ? 'Call' : 'Put'
          lines.push(`      ${opt.code} (${direction}${type}) x${opt.contracts}, 行权价${opt.strikePrice}, DTE=${opt.dte}`)
        }
      }
    }
  }

  // 中风险策略
  if (mediumRisk.length > 0) {
    lines.push(`\n🟡 中风险 (${mediumRisk.length}个):`)
    for (const item of mediumRisk) {
      const strategy = item.status
      lines.push(`  ${strategy.strategyName} - ${item.riskReason}`)
      if (item.portfolioPnL) {
        lines.push(`    组合盈亏: $${item.portfolioPnL.totalPnL.toFixed(0)} (${item.portfolioPnL.totalPnLPercent.toFixed(1)}%)`)
      }
    }
  }

  // 低风险策略（折叠显示）
  if (lowRisk.length > 0) {
    lines.push(`\n🟢 低风险 (${lowRisk.length}个):`)
    for (const item of lowRisk) {
      const strategy = item.status
      const pnlStr = item.portfolioPnL 
        ? `, 组合盈亏$${item.portfolioPnL.totalPnL.toFixed(0)}`
        : ''
      lines.push(`  ${strategy.strategyName} - ${item.riskReason}${pnlStr}`)
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