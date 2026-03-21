#!/usr/bin/env node
// Main entry point for options-monitor

import {
  fetchAllStrategies,
  fetchStrategyDetailAndOrders,
} from './fetcher.js'
import {
  buildStrategyStatus,
  checkStopLoss,
  generateReport,
  writeReportToFile,
  printReportSummary,
} from './report.js'
import { checkPositionAdjustments } from './rules.js'
import { StrategyStatus, StopLossAlert, PositionAdjustmentAlert } from './types.js'

/**
 * Main monitoring function
 */
async function monitor(): Promise<void> {
  const strategies: StrategyStatus[] = []
  const alerts: StopLossAlert[] = []
  const adjustmentAlerts: PositionAdjustmentAlert[] = []
  const noOptionsPositions: string[] = []
  const fetchErrors: string[] = []

  try {
    // Fetch all strategies
    const allStrategies = await fetchAllStrategies()

    // Filter strategies with auto_trade enabled
    const autoTradeStrategies = allStrategies.filter(
      s => s.ext?.auto_trade === "true"
    )
    console.log(`找到 ${allStrategies.length} 个策略，其中 ${autoTradeStrategies.length} 个开启自动交易\n`)

    // Process each auto-trade strategy
    for (const strategy of autoTradeStrategies) {
      console.log(`处理策略: ${strategy.strategyName}...`)

      try {
        const detail = await fetchStrategyDetailAndOrders(strategy.strategyId)
        const status = buildStrategyStatus(strategy, detail)
        strategies.push(status)

        // Check for stop loss alerts on options
        for (const option of status.options) {
          const alert = checkStopLoss(
            strategy.strategyId,
            strategy.strategyName,
            option
          )
          if (alert) {
            alerts.push(alert)
          }
        }

        // Check for position adjustment alerts
        const positionAlerts = checkPositionAdjustments(
          strategy.strategyId,
          strategy.strategyName,
          status.strategyCode,
          status
        )
        adjustmentAlerts.push(...positionAlerts)

        // Check if no open options
        if (status.openOptionsQuantity === 0 && status.options.length === 0) {
          noOptionsPositions.push(strategy.strategyId)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        fetchErrors.push(`获取策略 ${strategy.strategyName} 详情失败: ${message}`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fetchErrors.push(`获取策略列表失败: ${message}`)
  }

  // Generate and output report
  const report = generateReport(strategies, alerts, adjustmentAlerts, noOptionsPositions, fetchErrors)

  // Write to file
  writeReportToFile(report)

  // Print summary to console
  printReportSummary(report)

  // Exit with error code if there are alerts or errors
  if (alerts.length > 0) {
    process.exit(1)
  }
}

// Run monitor
monitor().catch((error) => {
  console.error('监控执行失败:', error)
  process.exit(1)
})