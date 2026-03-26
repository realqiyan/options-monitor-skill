// Options Monitor - Minimal Type Definitions

// ============================================
// API Response Types (from options-trade API)
// ============================================

// Strategy from queryAllStrategy
export interface Strategy {
  strategyId: string
  strategyName: string
  strategyCode: 'wheel_strategy' | 'cc_strategy' | 'default'
  stage: string
  startTime: string
  code: string // Stock code
  lotSize: number
  status: number
  ext: {
    auto_trade?: string
    need_evaluate?: string
    [key: string]: string | undefined
  }
}

// Strategy summary from queryStrategyDetailAndOrders
export interface StrategySummary {
  strategyDelta: number
  optionsDelta: number
  optionsGamma: number
  optionsTheta: number
  openOptionsQuantity: number
  avgDelta: number
  holdStockNum: number
  holdStockCost: number
  holdStockProfit: number
  totalStockCost: number
  averageStockCost: number
  currentStockPrice: number
  putMarginOccupied: number
}

// Order from queryStrategyDetailAndOrders
export interface Order {
  id: string
  code: string
  market: number
  side: string // 买入、卖出、卖空、买回
  price: number
  quantity: number
  orderFee: number
  tradeTime: string
  strikeTime: string
  status: string
  groupId: string
  tradeFrom: string
  subOrder: boolean
  isOpen?: string // 未平仓 or 已平仓
  groupTotalIncome?: number
  groupTotalOrderFee?: number
  ext?: {
    codeType?: string // PUT, CALL, STOCK
    curDTE?: string
    strikePrice?: string
    isPut?: string
    isCall?: string
    curPrice?: string
    [key: string]: string | undefined
  }
}

// Order group for Roll detection
export interface OrderGroup {
  totalIncome: number
  totalOrderFee: number
  orderCount: number
}

// Response from queryStrategyDetailAndOrders
export interface StrategyDetail {
  data: Strategy
  summary: StrategySummary
  orders: Order[]
  orderGroups: Record<string, OrderGroup>
}

// Options realtime data from queryOptionsRealtimeData
export interface OptionsRealtimeData {
  code: string
  delta: number
  gamma: number
  theta: number
  vega: number
  curPrice: number
}

// ============================================
// Monitor Output Types
// ============================================

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW'

// Position info for report
export interface PositionInfo {
  code: string
  type: 'CALL' | 'PUT'
  direction: 'BUY' | 'SELL'
  quantity: number
  strikePrice: number
  dte: number
  currentPrice: number
  costPrice: number
  pnl: number
  isITM: boolean
}

// Roll operation context
export interface RollContext {
  groupId: string
  closedCode: string
  openedCode: string
  rollTime: Date
  totalIncome: number
  daysSinceRoll: number
}

// Risk assessment result
export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
}

// Strategy risk report
export interface StrategyRiskReport {
  strategyId: string
  strategyName: string
  strategyCode: string
  stockCode: string
  stockPrice: number
  holdStockNum: number
  averageStockCost: number

  // Risk
  risk: RiskAssessment

  // Positions
  positions: PositionInfo[]

  // PnL
  stockPnL: number
  optionPnL: number
  totalPnL: number

  // Roll operations
  rollOperations: RollContext[]
}

// Full monitor report
export interface MonitorReport {
  generatedAt: string
  strategies: StrategyRiskReport[]
}