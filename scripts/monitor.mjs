#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/api.ts
var api_exports = {};
__export(api_exports, {
  fetchAllStrategies: () => fetchAllStrategies,
  fetchOptionsRealtime: () => fetchOptionsRealtime,
  fetchOptionsRealtimePrices: () => fetchOptionsRealtimePrices,
  fetchStrategyDetail: () => fetchStrategyDetail
});
import { execSync } from "child_process";
function callApi(tool, params = {}) {
  const paramStr = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" ");
  const cmd = `mcporter call options-trade.${tool} ${paramStr}`.trim();
  try {
    const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`API call failed: ${tool} - ${error}`);
  }
}
async function fetchAllStrategies() {
  const response = callApi("queryAllStrategy");
  return response.data || [];
}
async function fetchStrategyDetail(strategyId) {
  return callApi("queryStrategyDetailAndOrders", { strategyId });
}
async function fetchOptionsRealtime(code) {
  try {
    return callApi("queryOptionsRealtimeData", { code });
  } catch {
    return null;
  }
}
async function fetchOptionsRealtimePrices(codes) {
  const result = /* @__PURE__ */ new Map();
  for (const code of codes) {
    const data = await fetchOptionsRealtime(code);
    if (data) {
      result.set(code, data);
    }
  }
  return result;
}
var init_api = __esm({
  "src/api.ts"() {
    "use strict";
  }
});

// src/index.ts
init_api();
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// src/risk.ts
function isITM(strikePrice, stockPrice, isCall) {
  if (isCall) {
    return stockPrice > strikePrice;
  } else {
    return stockPrice < strikePrice;
  }
}
function calculateOptionPnL(direction, costPrice, currentPrice, quantity) {
  if (direction === "SELL") {
    return (costPrice - currentPrice) * quantity * 100;
  } else {
    return (currentPrice - costPrice) * quantity * 100;
  }
}
function calculateStockPnL(holdStockNum, averageStockCost, stockPrice) {
  return (stockPrice - averageStockCost) * holdStockNum;
}
function detectRollOperations(orders, orderGroups) {
  const rollOperations = [];
  const groupMap = /* @__PURE__ */ new Map();
  for (const order of orders) {
    if (!order.groupId)
      continue;
    if (order.ext?.codeType === "STOCK")
      continue;
    const existing = groupMap.get(order.groupId) || [];
    existing.push(order);
    groupMap.set(order.groupId, existing);
  }
  for (const [groupId, groupOrders] of groupMap) {
    const closed = groupOrders.filter((o) => o.isOpen === "\u5DF2\u5E73\u4ED3");
    const opened = groupOrders.filter((o) => o.isOpen === "\u672A\u5E73\u4ED3");
    if (closed.length === 0 || opened.length === 0)
      continue;
    const groupInfo = orderGroups[groupId];
    const totalIncome = groupInfo?.totalIncome ?? 0;
    const rollTime = new Date(
      Math.max(...groupOrders.map((o) => new Date(o.tradeTime).getTime()))
    );
    const daysSinceRoll = Math.floor(
      (Date.now() - rollTime.getTime()) / (1e3 * 60 * 60 * 24)
    );
    for (const closedOrder of closed) {
      for (const openedOrder of opened) {
        rollOperations.push({
          groupId,
          closedCode: closedOrder.code,
          openedCode: openedOrder.code,
          rollTime,
          totalIncome,
          daysSinceRoll
        });
      }
    }
  }
  return rollOperations;
}
function buildPositions(orders, realtimeData, stockPrice) {
  const positions = [];
  const codeToOrder = /* @__PURE__ */ new Map();
  for (const order of orders) {
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
    const isCall = order.ext?.codeType === "CALL";
    const strikePrice = parseFloat(order.ext?.strikePrice || "0");
    const dte = parseInt(order.ext?.curDTE || "0");
    const realtime = realtimeData.get(order.code);
    const currentPrice = realtime?.curPrice ?? parseFloat(order.ext?.curPrice || "0");
    const costPrice = order.price;
    const direction = order.side === "\u5356\u51FA" || order.side === "\u5356\u7A7A" ? "SELL" : "BUY";
    const pnl = calculateOptionPnL(direction, costPrice, currentPrice, order.quantity);
    const itm = isITM(strikePrice, stockPrice, isCall);
    positions.push({
      code: order.code,
      type: isCall ? "CALL" : "PUT",
      direction,
      quantity: order.quantity,
      strikePrice,
      dte,
      currentPrice,
      costPrice,
      pnl,
      isITM: itm
    });
  }
  return positions;
}
function assessRisk(positions, rollOperations, totalPnL, holdStockNum, stockPrice, strategyCode) {
  const reasons = [];
  let level = "LOW";
  for (const pos of positions) {
    if (pos.type === "PUT" && pos.direction === "SELL" && pos.isITM && holdStockNum === 0) {
      reasons.push("\u5356Put\u4EF7\u5185(ITM)\uFF0C\u5B58\u5728\u6307\u6D3E\u63A5\u80A1\u98CE\u9669");
      level = "HIGH";
    }
  }
  for (const pos of positions) {
    if (pos.type === "CALL" && pos.direction === "SELL" && pos.isITM) {
      if (level !== "HIGH") {
        reasons.push("\u5356Call\u4EF7\u5185(ITM)\uFF0C\u5B58\u5728\u88AB\u884C\u6743\u98CE\u9669");
        if (level === "LOW") {
          level = "MEDIUM";
        }
      }
    }
  }
  const minDTE = positions.length > 0 ? Math.min(...positions.map((p) => p.dte)) : 999;
  if (minDTE <= 7 && level !== "HIGH") {
    reasons.push(`\u671F\u6743\u5373\u5C06\u5230\u671F(DTE=${minDTE}\u5929)`);
    if (level === "LOW") {
      level = "MEDIUM";
    }
  }
  for (const roll of rollOperations) {
    if (roll.daysSinceRoll <= 7 && roll.totalIncome < 0) {
      if (level === "LOW") {
        reasons.push(`Roll\u64CD\u4F5C\u7EC4\u5408\u4E8F\u635F$${Math.abs(roll.totalIncome)}`);
        level = "MEDIUM";
      }
    }
  }
  if (reasons.length === 0) {
    if (holdStockNum > 0) {
      const soldCall = positions.find((p) => p.type === "CALL" && p.direction === "SELL");
      if (soldCall) {
        reasons.push("\u5BF9\u51B2\u7B56\u7565\u6B63\u5E38\u8FD0\u884C");
      } else {
        reasons.push("\u7B56\u7565\u72B6\u6001\u6B63\u5E38");
      }
    } else {
      reasons.push("\u7B56\u7565\u72B6\u6001\u6B63\u5E38");
    }
  }
  return { level, reasons };
}
function assessStrategyRisk(detail, realtimeData) {
  const { data: strategy, summary, orders, orderGroups } = detail;
  const stockPrice = summary?.currentStockPrice ?? 0;
  const holdStockNum = summary?.holdStockNum ?? 0;
  const averageStockCost = summary?.averageStockCost ?? summary?.holdStockCost ?? 0;
  const rollOperations = detectRollOperations(orders || [], orderGroups || {});
  const positions = buildPositions(orders || [], realtimeData, stockPrice);
  const stockPnL = calculateStockPnL(holdStockNum, averageStockCost, stockPrice);
  let optionPnL = 0;
  const rollHandledCodes = /* @__PURE__ */ new Set();
  for (const roll of rollOperations) {
    if (roll.daysSinceRoll <= 7) {
      rollHandledCodes.add(roll.openedCode);
      optionPnL += roll.totalIncome;
    }
  }
  for (const pos of positions) {
    if (!rollHandledCodes.has(pos.code)) {
      optionPnL += pos.pnl;
    }
  }
  const totalPnL = stockPnL + optionPnL;
  const risk = assessRisk(positions, rollOperations, totalPnL, holdStockNum, stockPrice, strategy.strategyCode);
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
    rollOperations
  };
}

// src/index.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var OUTPUT_DIR = join(__dirname, "..", "output");
function formatReport(report) {
  const lines = [];
  lines.push(`## \u671F\u6743\u6301\u4ED3\u98CE\u9669\u62A5\u544A`);
  lines.push(`\u751F\u6210\u65F6\u95F4: ${report.generatedAt}`);
  lines.push("");
  const highRisk = report.strategies.filter((s) => s.risk.level === "HIGH");
  const mediumRisk = report.strategies.filter((s) => s.risk.level === "MEDIUM");
  const lowRisk = report.strategies.filter((s) => s.risk.level === "LOW");
  const allRolls = [];
  for (const s of report.strategies) {
    for (const roll of s.rollOperations) {
      if (roll.daysSinceRoll <= 30) {
        allRolls.push({ name: s.strategyName, roll });
      }
    }
  }
  if (highRisk.length > 0) {
    lines.push(`### \u{1F534} \u9AD8\u98CE\u9669 (${highRisk.length}\u4E2A)`);
    for (const s of highRisk) {
      lines.push("");
      lines.push(`**${s.strategyName}** (${s.strategyCode})`);
      lines.push(`- \u7B56\u7565ID: ${s.strategyId}`);
      lines.push(`- \u6807\u7684: ${s.stockCode} @ $${s.stockPrice.toFixed(2)}`);
      lines.push(`- \u6301\u80A1: ${s.holdStockNum}\u80A1`);
      lines.push(`- \u98CE\u9669\u539F\u56E0: ${s.risk.reasons.join(", ")}`);
      lines.push(`- \u7EC4\u5408\u76C8\u4E8F: $${s.totalPnL.toFixed(0)}`);
      if (s.positions.length > 0) {
        lines.push(`- \u671F\u6743\u6301\u4ED3:`);
        for (const pos of s.positions) {
          const dir = pos.direction === "SELL" ? "\u5356" : "\u4E70";
          const pnlStr = pos.pnl >= 0 ? `+$${pos.pnl.toFixed(0)}` : `-$${Math.abs(pos.pnl).toFixed(0)}`;
          lines.push(`  - ${pos.code} ${dir}${pos.type} x${pos.quantity}, \u884C\u6743\u4EF7$${pos.strikePrice}, DTE=${pos.dte}, \u76C8\u4E8F${pnlStr}`);
        }
      }
      lines.push("---");
    }
  }
  if (mediumRisk.length > 0) {
    lines.push(`### \u{1F7E1} \u4E2D\u98CE\u9669 (${mediumRisk.length}\u4E2A)`);
    for (const s of mediumRisk) {
      lines.push("");
      lines.push(`**${s.strategyName}** (${s.strategyCode})`);
      lines.push(`- \u7B56\u7565ID: ${s.strategyId}`);
      lines.push(`- \u98CE\u9669\u539F\u56E0: ${s.risk.reasons.join(", ")}`);
      lines.push(`- \u7EC4\u5408\u76C8\u4E8F: $${s.totalPnL.toFixed(0)}`);
    }
    lines.push("---");
  }
  if (lowRisk.length > 0) {
    lines.push(`### \u{1F7E2} \u4F4E\u98CE\u9669 (${lowRisk.length}\u4E2A)`);
    for (const s of lowRisk) {
      const pnlStr = s.totalPnL >= 0 ? `+$${s.totalPnL.toFixed(0)}` : `-$${Math.abs(s.totalPnL).toFixed(0)}`;
      lines.push(`- ${s.strategyName}: ${s.risk.reasons.join(", ")}, \u76C8\u4E8F${pnlStr}`);
    }
  }
  if (allRolls.length > 0) {
    lines.push("");
    lines.push(`### \u{1F504} \u8FD1\u671F\u5C55\u671F\u64CD\u4F5C (${allRolls.length}\u4E2A)`);
    for (const { name, roll } of allRolls) {
      const incomeStr = roll.totalIncome >= 0 ? `+$${roll.totalIncome}` : `-$${Math.abs(roll.totalIncome)}`;
      lines.push(`- ${name}: ${roll.closedCode} \u2192 ${roll.openedCode}, \u6536\u76CA${incomeStr} (${roll.daysSinceRoll}\u5929\u524D)`);
    }
  }
  return lines.join("\n");
}
async function monitor() {
  console.log("\u5F00\u59CB\u76D1\u63A7\u671F\u6743\u6301\u4ED3...\n");
  const reports = [];
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
        const detail = await fetchAllStrategies().then(
          (strategies) => (
            // Need to re-fetch detail, using a direct call
            Promise.resolve().then(() => (init_api(), api_exports)).then((api) => api.fetchStrategyDetail(strategy.strategyId))
          )
        );
        const optionCodes = [];
        for (const order of detail.orders || []) {
          if (order.isOpen === "\u672A\u5E73\u4ED3" && order.ext?.codeType !== "STOCK") {
            optionCodes.push(order.code);
          }
        }
        const realtimeData = await fetchOptionsRealtimePrices(optionCodes);
        const report2 = assessStrategyRisk(detail, realtimeData);
        reports.push(report2);
      } catch (error) {
        console.error(`  \u9519\u8BEF: ${error}`);
      }
    }
  } catch (error) {
    console.error(`\u83B7\u53D6\u7B56\u7565\u5217\u8868\u5931\u8D25: ${error}`);
    process.exit(1);
  }
  const report = {
    generatedAt: (/* @__PURE__ */ new Date()).toLocaleString("zh-CN"),
    strategies: reports
  };
  const output = formatReport(report);
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const outputFile = join(OUTPUT_DIR, "latest-report.txt");
  writeFileSync(outputFile, output, "utf-8");
  console.log("\n" + output);
  console.log(`
\u62A5\u544A\u5DF2\u4FDD\u5B58\u81F3: ${outputFile}`);
  const hasHighRisk = reports.some((r) => r.risk.level === "HIGH");
  if (hasHighRisk) {
    process.exit(1);
  }
}
monitor().catch((error) => {
  console.error("\u76D1\u63A7\u6267\u884C\u5931\u8D25:", error);
  process.exit(1);
});
