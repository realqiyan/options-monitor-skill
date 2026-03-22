# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Options trading strategy monitoring skill. Fetches automated options trading positions via `mcporter` CLI and generates status reports for Agent analysis.

## Development Commands

```bash
# Run monitor
options-monitor

# Development mode
cd scripts && npm install
npm run monitor    # tsx src/index.ts (dev)
npm run build      # TypeScript compile check
npm run bundle     # Rebuild monitor.mjs from source (required after .ts changes)
```

## Architecture

**Data Flow:**
```
fetchAllStrategies() → filter auto_trade=true → fetchStrategyDetailAndOrders()
→ buildStrategyStatus() → checkStopLoss() → generateReport() → writeReportToFile()
```

**Key Modules:**
- `fetcher.ts` - Wraps `mcporter call options-trade.<tool>` CLI commands
- `report.ts` - Builds StrategyStatus, checks stop-loss, generates text output
- `rules.ts` - Strategy rules analysis (delta, expiration, position adjustments)
- `types.ts` - Strategy, Order, OptionPosition, StopLossAlert interfaces
- `monitor.mjs` - Bundled single-file executable

**External Dependency:**
Requires `mcporter` CLI installed and configured to access options-trade API.

## Output

Reports saved to `scripts/output/latest-report.txt` containing:
- Stop-loss alerts (if any)
- Strategy details: ID, Delta, Theta, DTE, positions, PnL
- Strategies without open options (candidates for new positions)