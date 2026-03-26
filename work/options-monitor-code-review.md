# Options Monitor Code Review Report

**项目**: `/home/yhb/work/options-monitor-skill`  
**审查日期**: 2026-03-26  
**审查范围**: `scripts/src/rules.ts`, `scripts/src/report.ts`, `scripts/src/types.ts`

---

## 1. 代码架构评估

### 1.1 整体架构

项目采用模块化设计，职责分离清晰：

```
types.ts  → 类型定义和常量
rules.ts  → 业务规则（Delta 分析、持仓调整检查）
report.ts → 报告生成（止损检查、格式化输出）
index.ts  → 主入口（数据获取、流程编排）
```

**优点**:
- ✅ 模块职责清晰，符合单一职责原则
- ✅ 类型定义集中管理，便于维护
- ✅ 业务规则与报告生成分离

**缺点**:
- ❌ 存在代码重复（`isITM`、`calculatePnL` 在 rules.ts 和 report.ts 中重复定义）
- ❌ 止损逻辑与策略上下文脱节
- ❌ 报告输出没有有效过滤，信息过载

### 1.2 数据流

```
fetchAllStrategies → buildStrategyStatus → checkStopLoss → checkPositionAdjustments → generateReport
```

数据流清晰，但关键问题在于 `checkStopLoss` 函数缺少策略上下文信息。

---

## 2. 具体问题列表

### 2.1 🔴 严重问题

#### 问题 1: 止损告警没有区分对冲策略和单边卖期权

**位置**: `report.ts` - `checkStopLoss()` 函数 (L178-L207)

**问题描述**:
```typescript
export function checkStopLoss(
  strategyId: string,
  strategyName: string,
  position: OptionPosition
): StopLossAlert | null {
  // ...
  if (direction === 'SELL') {
    if (changePercent >= STOP_LOSS_THRESHOLDS.SELL_OPTION_GAIN_PERCENT) {
      // 卖出期权价格上涨 100% 触发告警
    }
  }
}
```

**影响**:
- **Covered Call 策略**: 持股 + 卖 Call，卖 Call 价格上涨 100% 是正常现象（股价上涨导致），有股票对冲，不应触发告警
- **Wheel 策略**: 持股期间卖 Call 同样有股票覆盖
- **单边卖期权**: 没有对冲，价格上涨 100% 应该告警

**当前行为**: 所有 SELL 方向期权统一使用 100% 阈值，导致对冲策略误告警

**修复建议**:
```typescript
export function checkStopLoss(
  strategyId: string,
  strategyName: string,
  strategyCode: string,  // 新增
  holdStockNum: number,  // 新增
  position: OptionPosition
): StopLossAlert | null {
  // 对冲策略（有持股 + 卖 Call）不触发止损告警
  if (strategyCode === 'cc_strategy' && holdStockNum > 0 && position.isCall) {
    return null
  }
  if (strategyCode === 'wheel_strategy' && holdStockNum > 0 && position.isCall) {
    return null
  }
  // ...
}
```

---

#### 问题 2: 所有策略都标记"需要 Agent 分析"，没有过滤

**位置**: `report.ts` - `formatReportAsText()` 函数 (L284-L286)

**问题描述**:
```typescript
lines.push(`\n📊 需要 Agent 继续分析的${report.strategies.length}个期权交易策略:`)
for (const strategy of report.strategies) {
  // 遍历所有策略，没有过滤
}
```

**影响**:
- 报告标题说"需要 Agent 继续分析"，但实际列出**所有**策略
- 正常运行的策略（Delta 在正常区间、无临近到期、无 ITM 风险）也被列出
- 用户需要手动筛选哪些策略真正需要关注
- 信息过载，降低报告可用性

**当前行为**: 
- `needsAttention` 变量已计算（L267-L273），但仅用于显示状态图标
- 没有根据 `needsAttention` 过滤策略列表

**修复建议**:
```typescript
// 方案 1: 只输出需要关注的策略
const strategiesNeedingAttention = report.strategies.filter(strategy => {
  const minDTE = getMinDTE(strategy.options)
  const analysis = analyzeDeltaForStrategy(...)
  const hasAdjustmentAlert = report.adjustmentAlerts.some(...)
  const hasNearExpiration = strategy.options.some(o => o.dte <= 7)
  const hasITMSoldOption = strategy.options.some(...)
  return analysis.needsAdjustment || hasAdjustmentAlert || hasNearExpiration || hasITMSoldOption
})

lines.push(`\n📊 需要 Agent 继续分析的${strategiesNeedingAttention.length}个策略:`)
for (const strategy of strategiesNeedingAttention) { ... }

// 可选：添加正常策略摘要
const normalStrategies = report.strategies.filter(s => !strategiesNeedingAttention.includes(s))
if (normalStrategies.length > 0) {
  lines.push(`\n✅ 正常运行的${normalStrategies.length}个策略:`)
  for (const strategy of normalStrategies) {
    lines.push(`  ${strategy.strategyName} (${strategy.stockCode})`)
  }
}
```

---

### 2.2 🟡 中等问题

#### 问题 3: 代码重复 - `isITM` 函数

**位置**: 
- `rules.ts` L234-L241
- `report.ts` L26-L33

**问题描述**: 两个文件中定义了完全相同的 `isITM` 函数

**影响**: 
- 代码维护成本增加
- 如果逻辑需要修改，需要同时修改两处

**修复建议**:
- 将 `isITM` 移动到 `rules.ts` 作为导出函数
- `report.ts` 从 `rules.ts` 导入

---

#### 问题 4: 代码重复 - `calculatePnL` 函数

**位置**: 
- `rules.ts` L219-L231
- `report.ts` L40-L52

**问题描述**: 两个文件中定义了完全相同的 `calculatePnL` 函数

**修复建议**: 同问题 3，统一移动到 `rules.ts`

---

#### 问题 5: StopLossAlert 类型缺少策略上下文

**位置**: `types.ts` L75-L82

**问题描述**:
```typescript
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
```

缺少 `strategyCode` 字段，导致告警处理时无法区分策略类型

**修复建议**:
```typescript
export interface StopLossAlert {
  strategyId: string
  strategyName: string
  strategyCode: string  // 新增
  orderCode: string
  type: 'BUY_STOP_LOSS' | 'SELL_STOP_LOSS'
  message: string
  currentPrice: number
  costPrice: number
  changePercent: number
}
```

---

### 2.3 🟢 轻微问题

#### 问题 6: STOP_LOSS_THRESHOLDS 没有策略差异化

**位置**: `types.ts` L85-L89

**问题描述**:
```typescript
export const STOP_LOSS_THRESHOLDS = {
  BUY_OPTION_LOSS_PERCENT: 50,
  SELL_OPTION_GAIN_PERCENT: 100,
}
```

所有策略使用统一阈值，但不同策略风险承受能力不同

**修复建议**: 考虑按策略类型配置不同阈值，或添加策略特定的止损规则函数

---

#### 问题 7: 存在已弃用代码未清理

**位置**: `report.ts` L68-L83

**问题描述**:
```typescript
/**
 * Analyze Delta for wheel strategy (legacy - kept for compatibility)
 * @deprecated Use analyzeDeltaForStrategy from rules.ts instead
 */
export function analyzeDelta(...)
```

已标记 `@deprecated` 但仍保留在代码中

**修复建议**: 
- 确认没有外部引用后删除
- 或移动到单独的 `legacy.ts` 文件

---

#### 问题 8: generateOptionDiagnostics 没有策略上下文

**位置**: `report.ts` L55-L67

**问题描述**: 
```typescript
export function generateOptionDiagnostics(
  option: OptionPosition,
  stockPrice: number
): string[]
```

生成的诊断提示没有考虑策略类型，例如：
- 对于 CC 策略的卖 Call，"存在被行权风险" 提示是多余的（本来就被设计为可能被行权）
- 对于 Wheel 策略，卖 Put 被行权接股是正常流程

**修复建议**: 添加 `strategyCode` 参数，根据策略类型调整提示内容

---

## 3. 改进建议

### 3.1 短期修复（高优先级）

1. **修复止损告警逻辑** (`report.ts`)
   - 为 `checkStopLoss` 添加 `strategyCode` 和 `holdStockNum` 参数
   - 对冲策略（CC/Wheel 持股期间卖 Call）不触发止损告警
   - 更新 `index.ts` 调用处传递策略上下文

2. **修复报告过滤逻辑** (`report.ts`)
   - 根据 `needsAttention` 过滤策略列表
   - 分离"需要关注"和"正常运行"策略的输出
   - 修正报告标题准确性

3. **消除代码重复**
   - 将 `isITM`、`calculatePnL` 统一到 `rules.ts`
   - `report.ts` 从 `rules.ts` 导入

### 3.2 中期改进（中优先级）

4. **完善类型定义** (`types.ts`)
   - `StopLossAlert` 添加 `strategyCode` 字段
   - 考虑添加策略特定的止损阈值配置

5. **改进诊断提示** (`report.ts`)
   - `generateOptionDiagnostics` 添加策略上下文
   - 根据策略类型调整风险提示的措辞

6. **清理弃用代码**
   - 删除或迁移 `@deprecated` 函数
   - 添加代码审查检查防止新的重复代码

### 3.3 长期优化（低优先级）

7. **配置化止损阈值**
   - 支持按策略类型配置不同的止损阈值
   - 考虑从外部配置文件读取

8. **增加单元测试**
   - 为 `checkStopLoss`、`analyzeDeltaForStrategy` 等核心函数添加测试
   - 覆盖不同策略类型的边界情况

9. **报告输出优化**
   - 支持多种输出格式（JSON、Markdown、HTML）
   - 支持按严重程度过滤告警

---

## 4. 代码质量评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构设计 | ⭐⭐⭐⭐ | 模块化清晰，职责分离良好 |
| 代码重复 | ⭐⭐ | 存在明显的函数重复定义 |
| 类型安全 | ⭐⭐⭐ | 类型定义完整，但缺少策略上下文 |
| 业务逻辑 | ⭐⭐ | 止损逻辑缺少策略区分，存在误报 |
| 可维护性 | ⭐⭐⭐ | 代码结构清晰，但有改进空间 |
| **综合评分** | **⭐⭐⭐** | 基础架构良好，核心逻辑需修复 |

---

## 5. 总结

项目整体架构设计合理，但存在两个**严重影响可用性**的问题：

1. **止损告警误报**: 对冲策略被错误标记为高风险，导致告警噪音
2. **报告信息过载**: 没有过滤正常策略，用户难以快速定位问题

建议优先修复这两个问题，然后逐步改进代码质量和可维护性。

---

**审查人**: 小码 (AI Coding Engineer)  
**审查时间**: 2026-03-26 21:48 HKT
