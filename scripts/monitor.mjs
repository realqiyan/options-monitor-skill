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

// src/report.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var OUTPUT_DIR = join(__dirname, "..", "output");
function getOutputFile() {
  return join(OUTPUT_DIR, "latest-report.txt");
}
function isITM(option, stockPrice) {
  if (option.isCall) {
    return stockPrice > option.strikePrice;
  } else {
    return stockPrice < option.strikePrice;
  }
}
function calculatePnL(option) {
  if (option.costPrice <= 0)
    return 0;
  if (option.direction === "SELL") {
    return (option.costPrice - option.currentPrice) / option.costPrice * 100;
  } else {
    return (option.currentPrice - option.costPrice) / option.costPrice * 100;
  }
}
function generateOptionDiagnostics(option, stockPrice) {
  const tips = [];
  const pnl = calculatePnL(option);
  const pnlSign = pnl >= 0 ? "+" : "";
  const itm = isITM(option, stockPrice);
  const itmStatus = itm ? "\u4EF7\u5185(ITM)" : "\u4EF7\u5916(OTM)";
  tips.push(`\u{1F4C8} \u76C8\u4E8F: ${pnlSign}${pnl.toFixed(1)}% | ${itmStatus}`);
  if (option.dte <= 3) {
    tips.push(`\u23F0 DTE=${option.dte}\uFF0C\u671F\u6743\u5373\u5C06\u5230\u671F\uFF0C\u9700\u7ACB\u5373\u5904\u7406`);
  } else if (option.dte <= 7) {
    tips.push(`\u23F0 DTE=${option.dte}\uFF0C\u671F\u6743\u5373\u5C06\u5230\u671F\uFF0C\u8003\u8651\u5E73\u4ED3\u6216\u5C55\u671F`);
  }
  if (option.direction === "SELL" && itm) {
    tips.push(`\u26A0\uFE0F \u5356\u51FA\u671F\u6743\u5DF2\u4EF7\u5185\uFF0C\u5B58\u5728\u88AB\u884C\u6743\u98CE\u9669`);
  }
  return tips;
}
function analyzeDelta(normalizedDelta, strategyCode, holdStockNum) {
  if (strategyCode === "wheel_strategy") {
    if (holdStockNum === 0) {
      if (normalizedDelta > 0.3) {
        return `\u{1F4A1} Delta=${normalizedDelta.toFixed(2)} \u504F\u9AD8\uFF0C\u5356Put\u7B56\u7565\u5EFA\u8BAE Delta < 0.3`;
      }
    } else {
      if (normalizedDelta < 0.5) {
        return `\u{1F4A1} Delta=${normalizedDelta.toFixed(2)} \u504F\u4F4E\uFF0C\u5356Call\u7B56\u7565\u5EFA\u8BAE Delta > 0.5`;
      }
    }
  }
  return null;
}
function calculateDTE(strikeTime) {
  const expiration = new Date(strikeTime);
  const now = /* @__PURE__ */ new Date();
  const diffMs = expiration.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1e3 * 60 * 60 * 24)));
}
function checkStopLoss(strategyId, strategyName, position) {
  const { direction, currentPrice, costPrice, code } = position;
  if (costPrice <= 0 || currentPrice <= 0) {
    return null;
  }
  const changePercent = (currentPrice - costPrice) / costPrice * 100;
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
  if (order.ext?.isClose === "true") {
    return null;
  }
  if (order.ext?.codeType === "STOCK") {
    return null;
  }
  const direction = order.side === 2 || order.side === 3 ? "SELL" : "BUY";
  const groupInfo = orderGroups[order.groupId];
  const avgPrice = groupInfo && groupInfo.orderCount > 0 ? Math.abs(groupInfo.totalIncome) / (order.quantity * 100) : order.price;
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
  const strategyData = detail.data;
  const options = [];
  const seenCodes = /* @__PURE__ */ new Set();
  for (const order of detail.orders) {
    if (seenCodes.has(order.code))
      continue;
    seenCodes.add(order.code);
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
    stockPrice: summary.currentStockPrice,
    holdStockNum: summary.holdStockNum,
    lotSize: strategyData.lotSize,
    normalizedDelta: summary.avgDelta,
    optionsDelta: summary.optionsDelta,
    optionsTheta: summary.optionsTheta,
    openOptionsQuantity: summary.openOptionsQuantity,
    options,
    allOptionsIncome: summary.allOptionsIncome,
    allIncome: summary.allIncome
  };
}
function generateReport(strategies, alerts, noOptionsPositions, fetchErrors) {
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    strategies,
    alerts,
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
  lines.push(`
\u{1F4CA} \u9700\u8981Agent\u7EE7\u7EED\u5206\u6790\u7684${report.strategies.length}\u4E2A\u671F\u6743\u4EA4\u6613\u7B56\u7565:`);
  for (const strategy of report.strategies) {
    lines.push(`
  ${strategy.strategyName} (${strategy.strategyCode})`);
    lines.push(`    \u7B56\u7565ID: ${strategy.strategyId}`);
    lines.push(`    \u6807\u7684: ${strategy.stockCode} @ ${strategy.stockPrice.toFixed(2)}`);
    lines.push(`    Delta: \u7B56\u7565 ${strategy.normalizedDelta.toFixed(2)}, \u671F\u6743 ${strategy.optionsDelta.toFixed(2)}`);
    const deltaTip = analyzeDelta(
      strategy.normalizedDelta,
      strategy.strategyCode,
      strategy.holdStockNum
    );
    if (deltaTip) {
      lines.push(`    ${deltaTip}`);
    }
    lines.push(`    Theta: ${strategy.optionsTheta.toFixed(4)}`);
    lines.push(`    \u6301\u80A1: ${strategy.holdStockNum}, \u624B\u6570: ${strategy.lotSize}, \u671F\u6743: ${strategy.openOptionsQuantity}`);
    lines.push(`    \u7D2F\u8BA1\u6536\u76CA: \u671F\u6743 ${strategy.allOptionsIncome.toFixed(2)}, \u603B\u8BA1 ${strategy.allIncome.toFixed(2)}`);
    if (strategy.options.length > 0) {
      lines.push(`    \u671F\u6743\u6301\u4ED3:`);
      for (const opt of strategy.options) {
        const direction = opt.direction === "SELL" ? "\u5356" : "\u4E70";
        const type = opt.isCall ? "Call" : "Put";
        lines.push(`      ${opt.code} (${direction}${type}) x${opt.contracts}`);
        lines.push(`        \u884C\u6743\u4EF7: ${opt.strikePrice} | DTE: ${opt.dte} | \u6210\u672C: ${opt.costPrice} | \u73B0\u4EF7: ${opt.currentPrice}`);
        const diagnostics = generateOptionDiagnostics(opt, strategy.stockPrice);
        for (const tip of diagnostics) {
          lines.push(`        ${tip}`);
        }
      }
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
async function monitor() {
  const strategies = [];
  const alerts = [];
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
        strategies.push(status);
        for (const option of status.options) {
          const alert = checkStopLoss(
            strategy.strategyId,
            strategy.strategyName,
            option
          );
          if (alert) {
            alerts.push(alert);
          }
        }
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
  const report = generateReport(strategies, alerts, noOptionsPositions, fetchErrors);
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
