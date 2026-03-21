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

// src/rules.ts
function analyzeCCStrategyDelta(currentDelta, minDTE) {
  const WEEKS_3_DAYS = 21;
  if (minDTE <= WEEKS_3_DAYS) {
    if (currentDelta > 0.25 && currentDelta < 0.75) {
      const targetDelta = currentDelta > 0.5 ? currentDelta - 0.1 : currentDelta + 0.1;
      return {
        strategyCode: "cc_strategy",
        currentDelta,
        targetDelta: Math.round(targetDelta * 100) / 100,
        needsAdjustment: true,
        reason: `DTE=${minDTE}\u5929<=3\u5468\uFF0C\u9700\u8C03\u6574delta\u54110.5\u9760\u8FD1`
      };
    }
  }
  if (currentDelta >= 0.75) {
    return {
      strategyCode: "cc_strategy",
      currentDelta,
      targetDelta: 0.5,
      needsAdjustment: true,
      reason: `Delta=${currentDelta.toFixed(2)}>=0.75\uFF0C\u9700\u5411\u4E0B\u8C03\u6574\u81F30.5`
    };
  }
  if (currentDelta <= 0.25) {
    const targetDelta = Math.max(currentDelta + 0.1, 0.35);
    return {
      strategyCode: "cc_strategy",
      currentDelta,
      targetDelta: Math.round(targetDelta * 100) / 100,
      needsAdjustment: true,
      reason: `Delta=${currentDelta.toFixed(2)}<=0.25\uFF0C\u9700\u5411\u4E0A\u8C03\u6574\u81F3${targetDelta.toFixed(2)}`
    };
  }
  if (minDTE <= WEEKS_3_DAYS) {
    return {
      strategyCode: "cc_strategy",
      currentDelta,
      targetDelta: null,
      needsAdjustment: true,
      reason: `DTE=${minDTE}\u5929<=3\u5468\uFF0C\u9700\u8003\u8651\u5C55\u671F`
    };
  }
  return {
    strategyCode: "cc_strategy",
    currentDelta,
    targetDelta: null,
    needsAdjustment: false,
    reason: `Delta\u5728\u6B63\u5E38\u533A\u95F4(0.25-0.75)`
  };
}
function analyzeWheelStrategyDelta(currentDelta, holdStockNum) {
  if (holdStockNum === 0) {
    if (currentDelta > 0.35) {
      return {
        strategyCode: "wheel_strategy",
        currentDelta,
        targetDelta: null,
        needsAdjustment: false,
        reason: `\u5F53\u524D\u6301\u80A1=0\uFF0C\u5F00\u4ED3\u5356Put\u5EFA\u8BAEDelta 0.10-0.35`
      };
    }
  } else {
    return {
      strategyCode: "wheel_strategy",
      currentDelta,
      targetDelta: null,
      needsAdjustment: false,
      reason: `\u6301\u6709\u80A1\u7968${holdStockNum}\u80A1\uFF0C\u5356Call\u7B56\u7565`
    };
  }
  return {
    strategyCode: "wheel_strategy",
    currentDelta,
    targetDelta: null,
    needsAdjustment: false,
    reason: `Delta\u5728\u6B63\u5E38\u72B6\u6001`
  };
}
function analyzeDefaultStrategyDelta(currentDelta) {
  if (currentDelta < 0.15) {
    return {
      strategyCode: "default",
      currentDelta,
      targetDelta: null,
      needsAdjustment: false,
      reason: `Delta=${currentDelta.toFixed(2)}<0.15\uFF0C\u5356\u671F\u6743\u5EFA\u8BAEDelta 0.15-0.35`
    };
  }
  if (currentDelta > 0.35) {
    return {
      strategyCode: "default",
      currentDelta,
      targetDelta: null,
      needsAdjustment: false,
      reason: `Delta=${currentDelta.toFixed(2)}>0.35\uFF0C\u5356\u671F\u6743\u5EFA\u8BAEDelta 0.15-0.35`
    };
  }
  return {
    strategyCode: "default",
    currentDelta,
    targetDelta: null,
    needsAdjustment: false,
    reason: `Delta\u5728\u6B63\u5E38\u533A\u95F4(0.15-0.35)`
  };
}
function analyzeDeltaForStrategy(strategyCode, normalizedDelta, minDTE, holdStockNum) {
  switch (strategyCode) {
    case "cc_strategy":
      return analyzeCCStrategyDelta(normalizedDelta, minDTE);
    case "wheel_strategy":
      return analyzeWheelStrategyDelta(normalizedDelta, holdStockNum);
    case "default":
      return analyzeDefaultStrategyDelta(normalizedDelta);
    default:
      return {
        strategyCode,
        currentDelta: normalizedDelta,
        targetDelta: null,
        needsAdjustment: false,
        reason: `\u672A\u77E5\u7B56\u7565\u7C7B\u578B`
      };
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
function getMinDTE(options) {
  if (options.length === 0)
    return 999;
  return Math.min(...options.map((o) => o.dte));
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
function calculatePnL2(option) {
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
  const pnl = calculatePnL2(option);
  const pnlSign = pnl >= 0 ? "+" : "";
  const itm = isITM2(option, stockPrice);
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
function getDeltaAnalysisMessage(strategyCode, normalizedDelta, minDTE, holdStockNum) {
  const analysis = analyzeDeltaForStrategy(strategyCode, normalizedDelta, minDTE, holdStockNum);
  if (analysis.needsAdjustment || analysis.reason) {
    return `\u{1F4A1} ${analysis.reason}`;
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
function generateReport(strategies, alerts, adjustmentAlerts, noOptionsPositions, fetchErrors) {
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    strategies,
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
  lines.push(`
\u{1F4CA} \u9700\u8981Agent\u7EE7\u7EED\u5206\u6790\u7684${report.strategies.length}\u4E2A\u671F\u6743\u4EA4\u6613\u7B56\u7565:`);
  for (const strategy of report.strategies) {
    lines.push(`
  ${strategy.strategyName} (${strategy.strategyCode})`);
    lines.push(`    \u7B56\u7565ID: ${strategy.strategyId}`);
    lines.push(`    \u6807\u7684: ${strategy.stockCode} @ ${strategy.stockPrice.toFixed(2)}`);
    lines.push(`    Delta: \u7B56\u7565 ${strategy.normalizedDelta.toFixed(2)}, \u671F\u6743 ${strategy.optionsDelta.toFixed(2)}`);
    const minDTE = getMinDTE(strategy.options);
    const deltaMsg = getDeltaAnalysisMessage(
      strategy.strategyCode,
      strategy.normalizedDelta,
      minDTE,
      strategy.holdStockNum
    );
    if (deltaMsg) {
      lines.push(`    ${deltaMsg}`);
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
