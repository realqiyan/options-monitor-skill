// Types for options-monitor-skill

// Strategy from queryAllStrategy
export interface Strategy {
  id: string
  owner: string
  strategyId: string
  strategyName: string
  strategyCode: 'cc_strategy' | 'wheel_strategy' | 'default'
  stage: string
  startTime: string
  code: string // Stock code like BABA, JD
  lotSize: number
  status: number
  ext: {
    auto_trade?: string
    need_evaluate?: string
    initial_stock_num?: string
    initial_stock_cost?: string
    wheel_sellput_strike_price?: string
  }
}

// Response from queryAllStrategy
export interface AllStrategyResponse {
  allStrategy: Strategy[]
}

// Strategy summary from queryStrategyDetailAndOrders
export interface StrategySummary {
  strategy: Strategy
  optionsStrategy: {
    id: string
    owner: string
    code: string
    title: string
    type: number
    status: number
  }
  strategyDelta: number // Total delta including stock
  optionsDelta: number
  optionsGamma: number
  optionsTheta: number
  openOptionsQuantity: number
  openOptionsCallQuantity: number
  openOptionsPutQuantity: number
  avgDelta: number // Normalized delta
  totalFee: number
  allOptionsIncome: number
  allIncome: number
  unrealizedOptionsIncome: number
  holdStockNum: number
  holdStockProfit: number
  totalStockCost: number
  averageStockCost: number
  currentStockPrice: number
  putMarginOccupied: number
}

// Order from queryStrategyDetailAndOrders
export interface Order {
  id: string
  createTime: string
  updateTime: string
  strategyId: string
  underlyingCode: string
  code: string // Option code like BABA260220C180000
  market: number // 1=HK, 11=US
  tradeTime: string
  strikeTime: string // Expiration date
  side: number // 1=buy, 2=sell, 3=sell to open, 4=buy to close
  price: number
  orderFee: number
  quantity: number
  tradeFrom: string
  subOrder: boolean
  status: number // 11=filled
  owner: string
  platformOrderId: string
  platformOrderIdEx: string
  platformFillId: string
  ext: {
    lotSize?: string
    lastSyncStatus?: string
    isClose?: string
    codeType?: string // CALL or PUT
    totalIncome?: string
    curDTE?: string
    strikePrice?: string
    isCall?: string
  }
}

// Response from queryStrategyDetailAndOrders
export interface StrategyDetailResponse {
  includeStrategyRule: boolean
  strategySummary: StrategySummary
  orders: Order[]
}

// Position from queryAllPosition
export interface Position {
  owner: string
  securityCode: string
  market: number
  securityName: string
  quantity: number // Negative for sold options
  canSellQty: number
  costPrice: number
  currentPrice: number
}

// Response from queryAllPosition
export interface AllPositionResponse {
  positions: Position[]
}

// Stock price from queryStockRealPrice
export interface StockPriceResponse {
  code: string
  market: number
  price: number
  // Additional fields may exist
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
  allOptionsIncome: number
  allIncome: number
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

// Monitoring report output
export interface MonitoringReport {
  generatedAt: string
  strategies: StrategyStatus[]
  alerts: StopLossAlert[]
  noOptionsPositions: string[] // Strategy IDs with no open options
  fetchErrors: string[]
}

// Stop loss thresholds
export const STOP_LOSS_THRESHOLDS = {
  BUY_OPTION_LOSS_PERCENT: 50, // Buy option drops 50%
  SELL_OPTION_GAIN_PERCENT: 100, // Sell option rises 100%
}