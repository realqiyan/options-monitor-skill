// Risk Assessment - Core logic for options monitoring

import {
  Order,
  OrderGroup,
  StrategyDetail,
  OptionsRealtimeData,
  PositionInfo,
  RollContext,
  RiskAssessment,
  StrategyRiskReport,
} from './types.js'

// ============================================
// PnL Calculation
// ============================================

/**
 * Check if option is ITM (In-The-Money)
 */
export function isITM(
  strikePrice: number,
  stockPrice: number,
  isCall: boolean
): boolean {
  if (isCall) {
    return stockPrice > strikePrice
  } else {
    return stockPrice < strikePrice
  }
}

/**
 * Calculate PnL for a single option position
 */
export function calculateOptionPnL(
  direction: 'BUY' | 'SELL',
  costPrice: number,
  currentPrice: number,
  quantity: number
): number {
  if (direction === 'SELL') {
    // Sell: profit when price drops
    return (costPrice - currentPrice) * quantity * 100
  } else {
    // Buy: profit when price rises
    return (currentPrice - costPrice) * quantity * 100
  }
}

/**
 * Calculate stock PnL
 */
export function calculateStockPnL(
  holdStockNum: number,
  averageStockCost: number,
  stockPrice: number
): number {
  return (stockPrice - averageStockCost) * holdStockNum
}

// ============================================
// Roll Operation Detection
// ============================================

/**
 * Detect Roll operations from orders
 * A Roll has: same groupId + one closed + one opened
 */
export function detectRollOperations(
  orders: Order[],
  orderGroups: Record<string, OrderGroup>
): RollContext[] {
  const rollOperations: RollContext[] = []

  // Group orders by groupId
  const groupMap = new Map<string, Order[]>()
  for (const order of orders) {
    if (!order.groupId) continue
    if (order.ext?.codeType === 'STOCK') continue

    const existing = groupMap.get(order.groupId) || []
    existing.push(order)
    groupMap.set(order.groupId, existing)
  }

  // Find Roll patterns: closed + opened in same group
  for (const [groupId, groupOrders] of groupMap) {
    const closed = groupOrders.filter(o => o.isOpen === '已平仓')
    const opened = groupOrders.filter(o => o.isOpen === '未平仓')

    if (closed.length === 0 || opened.length === 0) continue

    const groupInfo = orderGroups[groupId]
    const totalIncome = groupInfo?.totalIncome ?? 0

    // Get roll time from most recent order
    const rollTime = new Date(
      Math.max(...groupOrders.map(o => new Date(o.tradeTime).getTime()))
    )

    const daysSinceRoll = Math.floor(
      (Date.now() - rollTime.getTime()) / (1000 * 60 * 60 * 24)
    )

    // Create Roll context for each closed-opened pair
    for (const closedOrder of closed) {
      for (const openedOrder of opened) {
        rollOperations.push({
          groupId,
          closedCode: closedOrder.code,
          openedCode: openedOrder.code,
          rollTime,
          totalIncome,
          daysSinceRoll,
        })
      }
    }
  }

  return rollOperations
}

/**
 * Find Roll context for an option code
 */
export function findRollContext(
  optionCode: string,
  rollOperations: RollContext[]
): RollContext | undefined {
  return rollOperations.find(r => r.openedCode === optionCode)
}

// ============================================
// Position Building
// ============================================

/**
 * Build position info from orders
 */
export function buildPositions(
  orders: Order[],
  realtimeData: Map<string, OptionsRealtimeData>,
  stockPrice: number
): PositionInfo[] {
  const positions: PositionInfo[] = []

  // Collect open option orders, prefer SELL over BUY for same code
  const codeToOrder = new Map<string, Order>()
  for (const order of orders) {
    if (order.isOpen !== '未平仓') continue
    if (order.ext?.codeType === 'STOCK') continue

    const existing = codeToOrder.get(order.code)
    if (!existing || order.side === '卖出' || order.side === '卖空') {
      codeToOrder.set(order.code, order)
    }
  }

  // Build position info
  for (const order of codeToOrder.values()) {
    const isCall = order.ext?.codeType === 'CALL'
    const strikePrice = parseFloat(order.ext?.strikePrice || '0')
    const dte = parseInt(order.ext?.curDTE || '0')

    // Get realtime price
    const realtime = realtimeData.get(order.code)
    const currentPrice = realtime?.curPrice ?? parseFloat(order.ext?.curPrice || '0')
    const costPrice = order.price

    // Calculate direction
    const direction: 'BUY' | 'SELL' =
      order.side === '卖出' || order.side === '卖空' ? 'SELL' : 'BUY'

    // Calculate PnL
    const pnl = calculateOptionPnL(direction, costPrice, currentPrice, order.quantity)

    // Check ITM
    const itm = isITM(strikePrice, stockPrice, isCall)

    positions.push({
      code: order.code,
      type: isCall ? 'CALL' : 'PUT',
      direction,
      quantity: order.quantity,
      strikePrice,
      dte,
      currentPrice,
      costPrice,
      pnl,
      isITM: itm,
    })
  }

  return positions
}

// ============================================
// Risk Assessment
// ============================================

/**
 * Determine risk level for a strategy
 */
export function assessRisk(
  positions: PositionInfo[],
  rollOperations: RollContext[],
  totalPnL: number,
  holdStockNum: number,
  stockPrice: number,
  strategyCode: string
): RiskAssessment {
  const reasons: string[] = []
  let level: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'

  // 1. Check for sold PUT ITM without stock (HIGH risk) - 车轮策略持币阶段
  for (const pos of positions) {
    if (pos.type === 'PUT' && pos.direction === 'SELL' && pos.isITM && holdStockNum === 0) {
      reasons.push('卖Put价内(ITM)，存在指派接股风险')
      level = 'HIGH'
    }
  }

  // 2. Check for sold CALL ITM (MEDIUM risk) - 车轮策略持股阶段/CC策略
  // 有股票时不作为高风险，但需要提醒
  for (const pos of positions) {
    if (pos.type === 'CALL' && pos.direction === 'SELL' && pos.isITM) {
      if (level !== 'HIGH') {
        reasons.push('卖Call价内(ITM)，存在被行权风险')
        if (level === 'LOW') {
          level = 'MEDIUM'
        }
      }
    }
  }

  // 3. Check DTE (MEDIUM risk)
  const minDTE = positions.length > 0
    ? Math.min(...positions.map(p => p.dte))
    : 999

  if (minDTE <= 7 && level !== 'HIGH') {
    reasons.push(`期权即将到期(DTE=${minDTE}天)`)
    if (level === 'LOW') {
      level = 'MEDIUM'
    }
  }

  // 4. Check Roll operations within 7 days
  for (const roll of rollOperations) {
    if (roll.daysSinceRoll <= 7 && roll.totalIncome < 0) {
      if (level === 'LOW') {
        reasons.push(`Roll操作组合亏损$${Math.abs(roll.totalIncome)}`)
        level = 'MEDIUM'
      }
    }
  }

  // 5. Default reasons
  if (reasons.length === 0) {
    if (holdStockNum > 0) {
      // Check for hedging (车轮持股+卖Call / CC策略)
      const soldCall = positions.find(p => p.type === 'CALL' && p.direction === 'SELL')
      if (soldCall) {
        reasons.push('对冲策略正常运行')
      } else {
        reasons.push('策略状态正常')
      }
    } else {
      // 持币阶段
      reasons.push('策略状态正常')
    }
  }

  return { level, reasons }
}

// ============================================
// Main Entry
// ============================================

/**
 * Assess strategy risk and build report
 */
export function assessStrategyRisk(
  detail: StrategyDetail,
  realtimeData: Map<string, OptionsRealtimeData>
): StrategyRiskReport {
  const { data: strategy, summary, orders, orderGroups } = detail

  const stockPrice = summary?.currentStockPrice ?? 0
  const holdStockNum = summary?.holdStockNum ?? 0
  const averageStockCost = summary?.averageStockCost ?? summary?.holdStockCost ?? 0

  // Detect Roll operations
  const rollOperations = detectRollOperations(orders || [], orderGroups || {})

  // Build positions
  const positions = buildPositions(orders || [], realtimeData, stockPrice)

  // Calculate PnL
  const stockPnL = calculateStockPnL(holdStockNum, averageStockCost, stockPrice)
  let optionPnL = 0

  // For options in Roll, use groupTotalIncome instead of individual PnL
  const rollHandledCodes = new Set<string>()
  for (const roll of rollOperations) {
    if (roll.daysSinceRoll <= 7) {
      rollHandledCodes.add(roll.openedCode)
      optionPnL += roll.totalIncome
    }
  }

  // For non-Roll options, calculate individual PnL
  for (const pos of positions) {
    if (!rollHandledCodes.has(pos.code)) {
      optionPnL += pos.pnl
    }
  }

  const totalPnL = stockPnL + optionPnL

  // Assess risk
  const risk = assessRisk(positions, rollOperations, totalPnL, holdStockNum, stockPrice, strategy.strategyCode)

  return {
    strategyId: strategy.strategyId,
    strategyName: strategy.strategyName,
    strategyCode: strategy.strategyCode,
    stockCode: strategy.code,
    stockPrice,
    holdStockNum,
    averageStockCost,
    risk,
    positions,
    stockPnL,
    optionPnL,
    totalPnL,
    rollOperations,
  }
}