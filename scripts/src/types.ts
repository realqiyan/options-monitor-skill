// Types for options-monitor-skill based on OPTIONS_QUERY_TOOLS.md

// Strategy from queryAllStrategy
export interface Strategy {
  strategyId: string
  strategyName: string
  strategyCode: 'cc_strategy' | 'wheel_strategy' | 'default'
  stage: string // running=运行中、suspend=暂停
  startTime: string
  code: string // Stock code like BABA, JD
  lotSize: number
  status: number // 1=启用，0=禁用
  ext: {
    auto_trade?: string
    need_evaluate?: string
    initial_stock_num?: string
    initial_stock_cost?: string
    wheel_sellput_strike_price?: string
    target_delta?: string
  }
}

// Response from queryAllStrategy
export interface AllStrategyResponse {
  data: Strategy[]
}

// Strategy summary from queryStrategyDetailAndOrders
export interface StrategySummary {
  strategyDelta: number // 策略总体Delta
  optionsDelta: number // 策略总体Options Delta
  optionsGamma: number
  optionsTheta: number
  openOptionsQuantity: number // 未平仓期权合约数
  avgDelta: number // 策略平均每股Delta
  holdStockNum: number // 持有股票数
  holdStockCost: number // 持有股票成本价
  holdStockProfit: number
  totalStockCost: number
  averageStockCost: number
  currentStockPrice: number
  putMarginOccupied: number
}

// Order from queryStrategyDetailAndOrders
export interface Order {
  code: string // 证券代码
  market: number // 市场代码
  side: string // 订单方向：买入、卖出、卖空、买回
  price: number
  quantity: number
  orderFee: number
  tradeTime: string
  strikeTime: string // 行权时间
  status: string // 订单状态（全部已成、已撤销等）
  groupId: string
  tradeFrom: string
  subOrder: boolean
  isOpen?: string // 是否未平仓（期权订单特有，值为"未平仓"或"已平仓"）
  groupTotalIncome?: number // 分组累计收益（多腿期权策略才有）
  groupTotalOrderFee?: number // 分组累计手续费（多腿期权策略才有）
  ext?: {
    lotSize?: string
    lastSyncStatus?: string
    codeType?: string // "PUT", "CALL", "STOCK"
    curDTE?: string // Current DTE, can be negative for expired
    strikePrice?: string
    isPut?: string
    isCall?: string
  }
}

// Order group info
export interface OrderGroup {
  totalIncome: number
  totalOrderFee: number
  orderCount: number
}

// Options realtime data from queryOptionsRealtimeData
export interface OptionsRealtimeData {
  code: string
  market: number
  delta: number
  gamma: number
  theta: number
  vega: number
  rho: number
  impliedVolatility: number
  curPrice: number
  openInterest: number
  volume: number
  timeValue?: number
  intrinsicValue?: number
  premium?: number
}

// Response from queryStrategyDetailAndOrders
export interface StrategyDetailResponse {
  data: Strategy
  summary: StrategySummary
  orders: Order[]
  orderGroups: Record<string, OrderGroup>
}

// Option position with calculated metrics
export interface OptionPosition {
  code: string
  direction: 'BUY' | 'SELL'
  contracts: number
  delta: number
  theta: number
  dte: number
  currentPrice: number
  costPrice: number
  strikePrice: number
  isCall: boolean
  status: number
}

// Strategy status for the report
export interface StrategyStatus {
  strategyId: string
  strategyName: string
  strategyCode: string
  stockCode: string
  stockPrice: number
  holdStockNum: number
  lotSize: number
  normalizedDelta: number
  optionsDelta: number
  optionsTheta: number
  openOptionsQuantity: number
  options: OptionPosition[]
}

// Stop loss alert
export interface StopLossAlert {
  strategyId: string
  strategyName: string
  orderCode: string
  type: 'BUY_STOP_LOSS' | 'SELL_STOP_LOSS'
  message: string
  currentPrice: number
  costPrice: number
  changePercent: number
}

// Stop loss thresholds
export const STOP_LOSS_THRESHOLDS = {
  BUY_OPTION_LOSS_PERCENT: 50, // Buy option drops 50%
  SELL_OPTION_GAIN_PERCENT: 100, // Sell option rises 100%
}

// Strategy rule from API
export interface StrategyRule {
  code: string
  title: string
  content: string
}

// Delta analysis result
export interface DeltaAnalysis {
  strategyCode: string
  currentDelta: number
  targetDelta: number | null
  needsAdjustment: boolean
  reason: string
}

// Position adjustment alert
export interface PositionAdjustmentAlert {
  strategyId: string
  strategyName: string
  strategyCode: string
  type: 'DELTA_ADJUSTMENT' | 'EXPIRATION_WARNING' | 'PUT_PROFIT_TAKE' | 'ASSIGNMENT_RISK'
  message: string
  details: Record<string, unknown>
}

// Monitoring report output
export interface MonitoringReport {
  generatedAt: string
  strategies: StrategyStatus[]
  alerts: StopLossAlert[]
  adjustmentAlerts: PositionAdjustmentAlert[]
  noOptionsPositions: string[]
  fetchErrors: string[]
}