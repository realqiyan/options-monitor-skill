#!/usr/bin/env node
// Options Monitor - Main Entry Point

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { fetchAllStrategies, fetchOptionsRealtimePrices } from './api.js'
import { assessStrategyRisk } from './risk.js'
import { MonitorReport, StrategyRiskReport, RollContext } from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const OUTPUT_DIR = join(__dirname, '..', 'output')

// ============================================
// Report Formatting
// ============================================

function formatReport(report: MonitorReport): string {
  const lines: string[] = []

  lines.push(`## 期权持仓风险报告`)
  lines.push(`生成时间: ${report.generatedAt}`)
  lines.push('')

  // Group by risk level
  const highRisk = report.strategies.filter(s => s.risk.level === 'HIGH')
  const mediumRisk = report.strategies.filter(s => s.risk.level === 'MEDIUM')
  const lowRisk = report.strategies.filter(s => s.risk.level === 'LOW')

  // Collect all roll operations
  const allRolls: Array<{ name: string; roll: RollContext }> = []
  for (const s of report.strategies) {
    for (const roll of s.rollOperations) {
      if (roll.daysSinceRoll <= 30) { // Only show rolls within 30 days
        allRolls.push({ name: s.strategyName, roll })
      }
    }
  }

  // High risk
  if (highRisk.length > 0) {
    lines.push(`### 🔴 高风险 (${highRisk.length}个)`)
    for (const s of highRisk) {
      lines.push('')
      lines.push(`**${s.strategyName}** (${s.strategyCode})`)
      lines.push(`- 策略ID: ${s.strategyId}`)
      lines.push(`- 标的: ${s.stockCode} @ $${s.stockPrice.toFixed(2)}`)
      lines.push(`- 持股: ${s.holdStockNum}股`)
      lines.push(`- 风险原因: ${s.risk.reasons.join(', ')}`)
      lines.push(`- 组合盈亏: $${s.totalPnL.toFixed(0)}`)

      if (s.positions.length > 0) {
        lines.push(`- 期权持仓:`)
        for (const pos of s.positions) {
          const dir = pos.direction === 'SELL' ? '卖' : '买'
          const pnlStr = pos.pnl >= 0 ? `+$${pos.pnl.toFixed(0)}` : `-$${Math.abs(pos.pnl).toFixed(0)}`
          lines.push(`  - ${pos.code} ${dir}${pos.type} x${pos.quantity}, 行权价$${pos.strikePrice}, DTE=${pos.dte}, 盈亏${pnlStr}`)
        }
      }
      lines.push('---')
    }
  }

  // Medium risk
  if (mediumRisk.length > 0) {
    lines.push(`### 🟡 中风险 (${mediumRisk.length}个)`)
    for (const s of mediumRisk) {
      lines.push('')
      lines.push(`**${s.strategyName}** (${s.strategyCode})`)
      lines.push(`- 策略ID: ${s.strategyId}`)
      lines.push(`- 风险原因: ${s.risk.reasons.join(', ')}`)
      lines.push(`- 组合盈亏: $${s.totalPnL.toFixed(0)}`)
    }
    lines.push('---')
  }

  // Low risk
  if (lowRisk.length > 0) {
    lines.push(`### 🟢 低风险 (${lowRisk.length}个)`)
    for (const s of lowRisk) {
      const pnlStr = s.totalPnL >= 0 ? `+$${s.totalPnL.toFixed(0)}` : `-$${Math.abs(s.totalPnL).toFixed(0)}`
      lines.push(`- ${s.strategyName}: ${s.risk.reasons.join(', ')}, 盈亏${pnlStr}`)
    }
  }

  // Roll operations
  if (allRolls.length > 0) {
    lines.push('')
    lines.push(`### 🔄 近期展期操作 (${allRolls.length}个)`)
    for (const { name, roll } of allRolls) {
      const incomeStr = roll.totalIncome >= 0
        ? `+$${roll.totalIncome}`
        : `-$${Math.abs(roll.totalIncome)}`
      lines.push(`- ${name}: ${roll.closedCode} → ${roll.openedCode}, 收益${incomeStr} (${roll.daysSinceRoll}天前)`)
    }
  }

  return lines.join('\n')
}

// ============================================
// Main Monitor Function
// ============================================

async function monitor(): Promise<void> {
  console.log('开始监控期权持仓...\n')

  const reports: StrategyRiskReport[] = []

  try {
    // Fetch all strategies
    const allStrategies = await fetchAllStrategies()

    // Filter auto-trade strategies
    const autoTradeStrategies = allStrategies.filter(
      s => s.ext?.auto_trade === 'true'
    )

    console.log(`找到 ${allStrategies.length} 个策略，其中 ${autoTradeStrategies.length} 个开启自动交易\n`)

    // Process each strategy
    for (const strategy of autoTradeStrategies) {
      console.log(`处理策略: ${strategy.strategyName}...`)

      try {
        // Fetch strategy detail
        const detail = await fetchAllStrategies().then(strategies =>
          // Need to re-fetch detail, using a direct call
          import('./api.js').then(api => api.fetchStrategyDetail(strategy.strategyId))
        )

        // Collect option codes
        const optionCodes: string[] = []
        for (const order of detail.orders || []) {
          if (order.isOpen === '未平仓' && order.ext?.codeType !== 'STOCK') {
            optionCodes.push(order.code)
          }
        }

        // Fetch realtime prices
        const realtimeData = await fetchOptionsRealtimePrices(optionCodes)

        // Assess risk
        const report = assessStrategyRisk(detail, realtimeData)
        reports.push(report)

      } catch (error) {
        console.error(`  错误: ${error}`)
      }
    }

  } catch (error) {
    console.error(`获取策略列表失败: ${error}`)
    process.exit(1)
  }

  // Build and output report
  const report: MonitorReport = {
    generatedAt: new Date().toLocaleString('zh-CN'),
    strategies: reports,
  }

  const output = formatReport(report)

  // Write to file
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  const outputFile = join(OUTPUT_DIR, 'latest-report.txt')
  writeFileSync(outputFile, output, 'utf-8')

  // Print to console
  console.log('\n' + output)
  console.log(`\n报告已保存至: ${outputFile}`)

  // Exit with error if high risk
  const hasHighRisk = reports.some(r => r.risk.level === 'HIGH')
  if (hasHighRisk) {
    process.exit(1)
  }
}

// Run
monitor().catch(error => {
  console.error('监控执行失败:', error)
  process.exit(1)
})