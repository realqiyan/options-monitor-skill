---
name: options-monitor-skill
description: 期权交易策略监控技能，获取自动化期权交易策略持仓数据，并输出状态报告。工具负责获取基础信息和初级告警，专职的Agent负责风险判断和行动决策。
---

# 期权策略监控

## 工具职责

1. **数据聚合** - 获取所有策略、持仓、价格数据
2. **止损告警** - 检查并输出止损触发状态
3. **数据输出** - Delta/Theta/DTE/收益率等数值（Agent 判断）
4. **文本报告** - 输出可读文本报告供 Agent 分析

## Agent 职责

1. **解读报告** - 理解当前持仓状态
2. **风险判断** - 决定 Delta/Theta/DTE 是否需要关注
3. **机会分析** - 无期权持仓时，转交给合适的Agent寻找交易机会
4. **行动决策** - 决定是否调整、平仓或开仓

## 使用方式

### 方式一：直接运行（推荐）

```bash
node scripts/monitor.mjs
```

### 方式二：开发模式

```bash
cd ./scripts
npm install        # 安装依赖
npm run monitor    # 运行监控
npm run build      # TypeScript 编译检查
npm run bundle     # 重新打包 monitor.mjs
```

## 输出格式

监控结果保存在 `scripts/output/latest-report.txt`，为可读的文本格式，与控制台输出一致。

### 报告内容

- **止损告警** - 触发止损的期权持仓（如有）
- **策略状态** - 每个策略的详细信息：
  - 策略ID、名称、代码
  - 标的股票代码和价格
  - Delta（策略总Delta + 期权Delta）
  - Theta
  - 持股数量、手数、期权持仓数
  - 累计收益（期权收益 + 总收益）
  - 期权持仓详情：代码、方向（买/卖）、类型（Call/Put）、合约数、DTE、行权价、成本价、现价
- **无期权持仓的策略** - 需要关注是否开仓
- **错误信息** - 数据获取失败（如有）

##  Agent继续分析

- 寻找合适的Agent继续分析列出的期权交易策略。

## 数据流程

```
fetchAllStrategies()           # 获取所有策略
  → 过滤 auto_trade=true       # 筛选自动交易策略
  → fetchStrategyDetailAndOrders()  # 获取策略详情和订单
  → fetchAllPositions()        # 获取持仓（用于当前价格）
  → buildStrategyStatus()      # 构建策略状态
  → checkStopLoss()            # 检查止损
  → generateReport()           # 生成报告
  → writeReportToFile()        # 写入文件
  → printReportSummary()       # 控制台输出
```

