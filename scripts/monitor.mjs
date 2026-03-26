#!/usr/bin/env node

// src/fetcher.ts
import { execSync } from "child_process";
function executeMcporter(toolName, params = {}) {
  const paramStr = Object.entries(params).map(([key, value]) => `${key}=${value}`).join(" ");
  const command = `mcporter call options-trade.${toolName} ${paramStr}`.trim();
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 3e4
    });
    return JSON.parse(output);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to execute ${toolName}: ${errorMessage}`);
  }
}
async function fetchAllStrategies() {
  const response = executeMcporter("queryAllStrategy");
  return response.data || [];
}
async function fetchStrategyDetailAndOrders(strategyId) {
  return executeMcporter("queryStrategyDetailAndOrders", { strategyId });
}
async function fetchOptionsRealtimeData(code, market = 11) {
  try {
    const response = executeMcporter("queryOptionsRealtimeData", { code, market });
    return response.data || null;
  } catch {
    return null;
  }
}

// src/report.ts
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// src/types.ts
var STOP_LOSS_THRESHOLDS = {
  BUY_OPTION_LOSS_PERCENT: 50,
  // Buy option drops 50%
  SELL_OPTION_GAIN_PERCENT: 100
  // Sell option rises 100%
};

// src/rules.ts
function calculatePnL(option) {
  if (option.costPrice <= 0)
    return 0;
  if (option.direction === "SELL") {
    return (option.costPrice - option.currentPrice) / option.costPrice * 100;
  } else {
    return (option.currentPrice - option.costPrice) / option.costPrice * 100;
  }
}
function isITM(option, stockPrice) {
  if (option.isCall) {
    return stockPrice > option.strikePrice;
  } else {
    return stockPrice < option.strikePrice;
  }
}
function checkWheelStrategyAdjustments(strategyId, strategyName, status) {
  const alerts = [];
  for (const option of status.options) {
    const pnl = calculatePnL(option);
    const itm = isITM(option, status.stockPrice);
    if (option.direction === "SELL" && !option.isCall) {
      if (pnl >= 80) {
        alerts.push({
          strategyId,
          strategyName,
          strategyCode: "wheel_strategy",
          type: "PUT_PROFIT_TAKE",
          message: `\u5356Put\u6536\u76CA${pnl.toFixed(1)}%>=80%\uFF0C\u5EFA\u8BAE\u5E73\u4ED3`,
          details: {
            code: option.code,
            pnl,
            strikePrice: option.strikePrice
          }
        });
      }
      if (itm) {
        alerts.push({
          strategyId,
          strategyName,
          strategyCode: "wheel_strategy",
          type: "ASSIGNMENT_RISK",
          message: `\u5356Put\u5DF2\u4EF7\u5185(ITM)\uFF0C\u5B58\u5728\u88AB\u6307\u6D3E\u63A5\u80A1\u98CE\u9669`,
          details: {
            code: option.code,
            strikePrice: option.strikePrice,
            stockPrice: status.stockPrice
          }
        });
      }
    }
  }
  return alerts;
}
function checkCCStrategyAdjustments(strategyId, strategyName, status) {
  const alerts = [];
  const WEEKS_3_DAYS = 21;
  for (const option of status.options) {
    if (option.dte <= WEEKS_3_DAYS) {
      alerts.push({
        strategyId,
        strategyName,
        strategyCode: "cc_strategy",
        type: "EXPIRATION_WARNING",
        message: `\u671F\u6743DTE=${option.dte}\u5929<=3\u5468\uFF0C\u9700\u8003\u8651\u5C55\u671F\u6216\u5E73\u4ED3`,
        details: {
          code: option.code,
          dte: option.dte,
          strikePrice: option.strikePrice
        }
      });
    }
  }
  return alerts;
}
function checkPositionAdjustments(strategyId, strategyName, strategyCode, status) {
  switch (strategyCode) {
    case "wheel_strategy":
      return checkWheelStrategyAdjustments(strategyId, strategyName, status);
    case "cc_strategy":
      return checkCCStrategyAdjustments(strategyId, strategyName, status);
    default:
      return [];
  }
}

// src/report.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var OUTPUT_DIR = join(__dirname, "..", "output");
function getOutputFile() {
  return join(OUTPUT_DIR, "latest-report.txt");
}
function isITM2(option, stockPrice) {
  if (option.isCall) {
    return stockPrice > option.strikePrice;
  } else {
    return stockPrice < option.strikePrice;
  }
}
function calculateDTE(strikeTime) {
  const expiration = new Date(strikeTime);
  const now = /* @__PURE__ */ new Date();
  const diffMs = expiration.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1e3 * 60 * 60 * 24)));
}
function calculatePortfolioPnL(holdStockNum, holdStockCost, stockPrice, options) {
  const stockCost = holdStockCost * holdStockNum;
  const stockValue = stockPrice * holdStockNum;
  const stockPnL = stockValue - stockCost;
  const stockPnLPercent = stockCost > 0 ? stockPnL / stockCost * 100 : 0;
  let optionPnL = 0;
  for (const opt of options) {
    if (opt.direction === "SELL") {
      optionPnL += (opt.costPrice - opt.currentPrice) * opt.contracts * 100;
    } else {
      optionPnL += (opt.currentPrice - opt.costPrice) * opt.contracts * 100;
    }
  }
  const totalCost = stockCost > 0 ? stockCost : 1;
  const totalPnL = stockPnL + optionPnL;
  const totalPnLPercent = totalPnL / totalCost * 100;
  return {
    stockPnL,
    stockPnLPercent,
    optionPnL,
    totalPnL,
    totalPnLPercent
  };
}
function assessRiskLevel(strategyCode, holdStockNum, options, stockPrice, portfolioPnL) {
  if (holdStockNum === 0) {
    const soldPut = options.find((o) => o.direction === "SELL" && !o.isCall);
    if (soldPut && isITM2(soldPut, stockPrice)) {
      return { level: "HIGH", reason: "\u5356Put\u4EF7\u5185(ITM)\uFF0C\u5B58\u5728\u88AB\u6307\u6D3E\u63A5\u80A1\u98CE\u9669" };
    }
  }
  if (portfolioPnL && portfolioPnL.totalPnLPercent < -20) {
    return { level: "HIGH", reason: `\u7EC4\u5408\u4E8F\u635F${portfolioPnL.totalPnLPercent.toFixed(1)}%\uFF0C\u8D85\u8FC720%\u9608\u503C` };
  }
  const minDTE = options.length > 0 ? Math.min(...options.map((o) => o.dte)) : 999;
  if (minDTE <= 7) {
    return { level: "MEDIUM", reason: `\u671F\u6743\u5373\u5C06\u5230\u671F(DTE=${minDTE}\u5929)` };
  }
  if (holdStockNum > 0 && strategyCode === "wheel_strategy") {
    const soldCall = options.find((o) => o.direction === "SELL" && o.isCall);
    if (soldCall) {
      if (portfolioPnL && portfolioPnL.totalPnL > 0) {
        return { level: "LOW", reason: "\u5BF9\u51B2\u7B56\u7565\u6B63\u5E38\u8FD0\u884C\uFF0C\u7EC4\u5408\u76C8\u5229" };
      }
      if (!isITM2(soldCall, stockPrice)) {
        return { level: "LOW", reason: "\u5BF9\u51B2\u7B56\u7565\u6B63\u5E38\u8FD0\u884C\uFF0C\u5356Call\u4EF7\u5916" };
      }
    }
  }
  return { level: "LOW", reason: "\u7B56\u7565\u72B6\u6001\u6B63\u5E38" };
}
function checkStopLoss(strategyId, strategyName, strategyCode, position, holdStockNum) {
  const { direction, currentPrice, costPrice, code } = position;
  if (costPrice <= 0 || currentPrice <= 0) {
    return null;
  }
  const changePercent = (currentPrice - costPrice) / costPrice * 100;
  if (direction === "SELL" && position.isCall && holdStockNum > 0) {
    return null;
  }
  if (direction === "BUY") {
    if (changePercent <= -STOP_LOSS_THRESHOLDS.BUY_OPTION_LOSS_PERCENT) {
      return {
        strategyId,
        strategyName,
        orderCode: code,
        type: "BUY_STOP_LOSS",
        message: `\u4E70\u5165\u671F\u6743\u4EF7\u683C\u4E0B\u8DCC ${Math.abs(changePercent).toFixed(1)}%\uFF0C\u89E6\u53D1\u6B62\u635F\u544A\u8B66`,
        currentPrice,
        costPrice,
        changePercent
      };
    }
  }
  if (direction === "SELL") {
    if (changePercent >= STOP_LOSS_THRESHOLDS.SELL_OPTION_GAIN_PERCENT) {
      return {
        strategyId,
        strategyName,
        orderCode: code,
        type: "SELL_STOP_LOSS",
        message: `\u5356\u51FA\u671F\u6743\u4EF7\u683C\u4E0A\u6DA8 ${changePercent.toFixed(1)}%\uFF0C\u89E6\u53D1\u6B62\u635F\u544A\u8B66`,
        currentPrice,
        costPrice,
        changePercent
      };
    }
  }
  return null;
}
function buildOptionPositionFromOrder(order, orderGroups) {
  const direction = order.side === "\u5356\u51FA" || order.side === "\u5356\u7A7A" ? "SELL" : "BUY";
  const avgPrice = order.groupTotalIncome != null ? Math.abs(order.groupTotalIncome) / (order.quantity * 100) : orderGroups?.[order.groupId] ? Math.abs(orderGroups[order.groupId].totalIncome) / (order.quantity * 100) : order.price;
  const isCall = order.ext?.codeType === "CALL";
  const isPut = order.ext?.codeType === "PUT" || order.ext?.isPut === "true";
  const strikePrice = order.ext?.strikePrice ? parseFloat(order.ext.strikePrice) : 0;
  let dte;
  if (order.ext?.curDTE !== void 0) {
    dte = parseInt(order.ext.curDTE);
  } else {
    dte = calculateDTE(order.strikeTime);
  }
  return {
    code: order.code,
    direction,
    contracts: order.quantity,
    delta: 0,
    theta: 0,
    dte,
    currentPrice: avgPrice,
    // Will be updated if we have position data
    costPrice: avgPrice,
    strikePrice,
    isCall: isCall || !isPut && order.code.includes("C") && !order.code.includes("P"),
    status: 0
  };
}
function buildStrategyStatus(strategy, detail) {
  const summary = detail.summary;
  const strategyData = detail.data ?? strategy;
  const options = [];
  const codeToOrder = /* @__PURE__ */ new Map();
  for (const order of detail.orders ?? []) {
    if (order.isOpen !== "\u672A\u5E73\u4ED3")
      continue;
    if (order.ext?.codeType === "STOCK")
      continue;
    const existing = codeToOrder.get(order.code);
    if (!existing || order.side === "\u5356\u51FA" || order.side === "\u5356\u7A7A") {
      codeToOrder.set(order.code, order);
    }
  }
  for (const order of codeToOrder.values()) {
    const optPos = buildOptionPositionFromOrder(order, detail.orderGroups);
    if (optPos) {
      options.push(optPos);
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
    options
  };
}
function generateReport(strategies, alerts, adjustmentAlerts, noOptionsPositions, fetchErrors) {
  const strategiesWithRisk = strategies.map((status) => {
    const portfolioPnL = calculatePortfolioPnL(
      status.holdStockNum,
      0,
      // holdStockCost 暂时不可用
      status.stockPrice,
      status.options
    );
    const risk = assessRiskLevel(
      status.strategyCode,
      status.holdStockNum,
      status.options,
      status.stockPrice,
      portfolioPnL
    );
    return {
      status,
      riskLevel: risk.level,
      riskReason: risk.reason,
      portfolioPnL
    };
  });
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    strategies,
    strategiesWithRisk,
    alerts,
    adjustmentAlerts,
    noOptionsPositions,
    fetchErrors
  };
}
function formatReportAsText(report) {
  const lines = [];
  if (report.alerts.length > 0) {
    lines.push("\n\u26A0\uFE0F  \u6B62\u635F\u544A\u8B66:");
    for (const alert of report.alerts) {
      lines.push(`  [${alert.strategyName}] ${alert.orderCode}`);
      lines.push(`    ${alert.message}`);
      lines.push(`    \u6210\u672C\u4EF7: ${alert.costPrice}, \u5F53\u524D\u4EF7: ${alert.currentPrice}`);
    }
  }
  if (report.adjustmentAlerts.length > 0) {
    lines.push("\n\u{1F4CB} \u6301\u4ED3\u8C03\u6574\u5EFA\u8BAE:");
    for (const alert of report.adjustmentAlerts) {
      lines.push(`  [${alert.strategyName}] ${alert.details.code || ""}`);
      lines.push(`    ${alert.message}`);
    }
  }
  const highRisk = report.strategiesWithRisk.filter((s) => s.riskLevel === "HIGH");
  const mediumRisk = report.strategiesWithRisk.filter((s) => s.riskLevel === "MEDIUM");
  const lowRisk = report.strategiesWithRisk.filter((s) => s.riskLevel === "LOW");
  if (highRisk.length > 0) {
    lines.push(`
\u{1F534} \u9AD8\u98CE\u9669 (${highRisk.length}\u4E2A):`);
    for (const item of highRisk) {
      const strategy = item.status;
      lines.push(`  ${strategy.strategyName} (${strategy.strategyCode})`);
      lines.push(`    \u7B56\u7565ID: ${strategy.strategyId}`);
      lines.push(`    \u6807\u7684: ${strategy.stockCode} @ ${strategy.stockPrice.toFixed(2)}`);
      lines.push(`    \u98CE\u9669\u539F\u56E0: ${item.riskReason}`);
      if (item.portfolioPnL) {
        lines.push(`    \u7EC4\u5408\u76C8\u4E8F: $${item.portfolioPnL.totalPnL.toFixed(0)} (${item.portfolioPnL.totalPnLPercent.toFixed(1)}%)`);
      }
      lines.push(`    \u5EFA\u8BAE: \u9700\u8981\u7ACB\u5373\u5904\u7406`);
      if (strategy.options.length > 0) {
        lines.push(`    \u671F\u6743\u6301\u4ED3:`);
        for (const opt of strategy.options) {
          const direction = opt.direction === "SELL" ? "\u5356" : "\u4E70";
          const type = opt.isCall ? "Call" : "Put";
          lines.push(`      ${opt.code} (${direction}${type}) x${opt.contracts}, \u884C\u6743\u4EF7${opt.strikePrice}, DTE=${opt.dte}`);
        }
      }
    }
  }
  if (mediumRisk.length > 0) {
    lines.push(`
\u{1F7E1} \u4E2D\u98CE\u9669 (${mediumRisk.length}\u4E2A):`);
    for (const item of mediumRisk) {
      const strategy = item.status;
      lines.push(`  ${strategy.strategyName} - ${item.riskReason}`);
      if (item.portfolioPnL) {
        lines.push(`    \u7EC4\u5408\u76C8\u4E8F: $${item.portfolioPnL.totalPnL.toFixed(0)} (${item.portfolioPnL.totalPnLPercent.toFixed(1)}%)`);
      }
    }
  }
  if (lowRisk.length > 0) {
    lines.push(`
\u{1F7E2} \u4F4E\u98CE\u9669 (${lowRisk.length}\u4E2A):`);
    for (const item of lowRisk) {
      const strategy = item.status;
      const pnlStr = item.portfolioPnL ? `, \u7EC4\u5408\u76C8\u4E8F$${item.portfolioPnL.totalPnL.toFixed(0)}` : "";
      lines.push(`  ${strategy.strategyName} - ${item.riskReason}${pnlStr}`);
    }
  }
  if (report.noOptionsPositions.length > 0) {
    lines.push("\n\u{1F4ED} \u65E0\u671F\u6743\u6301\u4ED3\u7684\u7B56\u7565:");
    for (const strategyId of report.noOptionsPositions) {
      const strategy = report.strategies.find((s) => s.strategyId === strategyId);
      if (strategy) {
        lines.push(`  ${strategy.strategyName} (${strategy.stockCode})`);
      }
    }
  }
  if (report.fetchErrors.length > 0) {
    lines.push("\n\u274C \u9519\u8BEF:");
    for (const error of report.fetchErrors) {
      lines.push(`  ${error}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
function writeReportToFile(report) {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const outputFile = getOutputFile();
  const content = formatReportAsText(report);
  writeFileSync(outputFile, content, "utf-8");
  console.log(`
Report saved to: ${outputFile}`);
}
function printReportSummary(report) {
  console.log(formatReportAsText(report));
}

// src/index.ts
async function updateOptionRealtimePrices(options) {
  for (const option of options) {
    try {
      const realtimeData = await fetchOptionsRealtimeData(option.code);
      if (realtimeData && realtimeData.curPrice > 0) {
        option.currentPrice = realtimeData.curPrice;
        option.delta = realtimeData.delta;
        option.theta = realtimeData.theta;
      }
    } catch {
    }
  }
}
async function monitor() {
  const strategies = [];
  const alerts = [];
  const adjustmentAlerts = [];
  const noOptionsPositions = [];
  const fetchErrors = [];
  try {
    const allStrategies = await fetchAllStrategies();
    const autoTradeStrategies = allStrategies.filter(
      (s) => s.ext?.auto_trade === "true"
    );
    console.log(`\u627E\u5230 ${allStrategies.length} \u4E2A\u7B56\u7565\uFF0C\u5176\u4E2D ${autoTradeStrategies.length} \u4E2A\u5F00\u542F\u81EA\u52A8\u4EA4\u6613
`);
    for (const strategy of autoTradeStrategies) {
      console.log(`\u5904\u7406\u7B56\u7565: ${strategy.strategyName}...`);
      try {
        const detail = await fetchStrategyDetailAndOrders(strategy.strategyId);
        const status = buildStrategyStatus(strategy, detail);
        if (status.options.length > 0) {
          await updateOptionRealtimePrices(status.options);
        }
        strategies.push(status);
        for (const option of status.options) {
          const alert = checkStopLoss(
            strategy.strategyId,
            strategy.strategyName,
            status.strategyCode,
            option,
            status.holdStockNum
          );
          if (alert) {
            alerts.push(alert);
          }
        }
        const positionAlerts = checkPositionAdjustments(
          strategy.strategyId,
          strategy.strategyName,
          status.strategyCode,
          status
        );
        adjustmentAlerts.push(...positionAlerts);
        if (status.openOptionsQuantity === 0 && status.options.length === 0) {
          noOptionsPositions.push(strategy.strategyId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fetchErrors.push(`\u83B7\u53D6\u7B56\u7565 ${strategy.strategyName} \u8BE6\u60C5\u5931\u8D25: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fetchErrors.push(`\u83B7\u53D6\u7B56\u7565\u5217\u8868\u5931\u8D25: ${message}`);
  }
  const report = generateReport(strategies, alerts, adjustmentAlerts, noOptionsPositions, fetchErrors);
  writeReportToFile(report);
  printReportSummary(report);
  if (alerts.length > 0) {
    process.exit(1);
  }
}
monitor().catch((error) => {
  console.error("\u76D1\u63A7\u6267\u884C\u5931\u8D25:", error);
  process.exit(1);
});
