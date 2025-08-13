# DAMM PNL Tracker

A **completely offline** command-line tool for tracking your cryptocurrency trading PnL (Profit and Loss). No private keys, no wallet connections, no blockchain queries - just local data storage with live price updates from CoinGecko.

##Privacy & Security

- **100% Offline Operation**: All your position data stays on your local machine
- **No Private Keys Required**: Never asks for or stores any sensitive information
- **No Wallet Connections**: No access to your actual crypto wallets
- **Local Data Only**: Uses simple JSON files for data storage
- **Minimal Network**: Only fetches public SOL price from CoinGecko API

## Features

- Real-time PnL Calculation** with live SOL price feeds
- **Smart Profit Taking** - distinguishes between capital reduction and pure profit
- **Advanced Position Management** - add capital, take profits, track fees
- **Smart Trading Suggestions** - get recommendations based on your position performance
- **Comprehensive Reporting** - daily summaries, win rates, expected value analysis
- **Beautiful CLI Interface** - color-coded output with progress indicators
- **Persistent Storage** - your data is saved locally between sessions

## Installation

### Prerequisites
- Node.js 16+ 
- npm or yarn

### Setup
```bash
# Clone the repository
git clone <your-repo-url>
cd damm-pnl-tracker

# Install dependencies
npm install

# Make the script executable
chmod +x damm-pnl.ts
```

## Quick Start

### 1. Create Your First Position
```bash
# Track a new position with $200 initial investment
./damm-pnl aixbt 200.00
```

### 2. Update Position Value
```bash
# Update position value to $275.50 and add $12.30 in fees claimed
./damm-pnl aixbt 275.50 12.30
```

### 3. Manage Your Capital
```bash
# Add more capital to existing position
./damm-pnl add-capital aixbt 100.00

# Take profit (smart logic: reduces capital first, then pure profit)
./damm-pnl take-profit aixbt 150.00
```

### 4. View Your Portfolio
```bash
# List all active positions
./damm-pnl list

# View closed positions
./damm-pnl closed

# See trading performance summary
./damm-pnl summary
```

## Core Commands

### Position Management
```bash
# Create or update position
./damm-pnl <token> <current_value_usd> [fees_claimed_usd]

# Add capital to position
./damm-pnl add-capital <token> <amount_usd>

# Take profit (intelligent capital vs profit tracking)
./damm-pnl take-profit <token> <amount_usd>

# Close position completely
./damm-pnl close <token> <exit_value_usd> [final_fees_usd]
```

### Portfolio Overview
```bash
# View active positions
./damm-pnl list

# View trading history
./damm-pnl closed

# Performance analytics
./damm-pnl summary
```

### Utilities
```bash
# Reset position to new value
./damm-pnl reset <token> <new_initial_value_usd>

# Remove position
./damm-pnl remove <token>

# Clean up invalid data
./damm-pnl clean

# Convert old format data
./damm-pnl fix
```

## Smart Profit Taking

The `take-profit` command intelligently handles your withdrawals:

```bash
# If you have $200 invested and take $300 profit:
./damm-pnl take-profit aixbt 300.00

# Result:
#  Capital reduction: $200.00 (your invested amount)
#  Pure profit: $100.00 (profit beyond investment)
#  Total invested: $200.00 � $0.00
```

This gives you accurate tracking of:
- How much capital you've recovered
- How much pure profit you've extracted
- Realistic PnL calculations

## Advanced Analytics

### Position Display Features
- **Unrealized PnL**: Current position value vs remaining invested capital
- **Realized PnL**: Capital reductions + profit taken + fees claimed
- **Total PnL**: Complete return on your original investment
- **PnL Percentage**: Performance against total capital invested
- **Smart Suggestions**: HOLD, TOP_UP, REDUCE, TAKE_PROFIT, STOP_LOSS recommendations

### Summary Reports
- **Daily Breakdown**: Last 7 days of trading activity
- **Win Rate Analysis**: Success ratio and performance metrics
- **Expected Value**: Statistical analysis of your trading strategy
- **Best/Worst Trades**: Track your biggest wins and losses

## Technical Details

### Data Storage
- **Position Data**: `damm_positions.json` (your trading positions)
- **Price Cache**: `sol_price_cache.json` (cached SOL prices to reduce API calls)

### Price Feed
- **Source**: CoinGecko API (public, no authentication required)
- **Caching**: 5-minute cache to minimize API requests
- **Fallback**: Uses cached data if API is unavailable
- **Timeout**: 10-second request timeout for reliability

### Security Features
- **No Sensitive Data**: Never stores private keys, seeds, or wallet info
- **Input Validation**: All user inputs are validated and sanitized
- **Error Handling**: Graceful error handling prevents data corruption
- **Local Only**: No data transmission except public price fetching

### Suggestion Thresholds
The trading suggestions are based on configurable thresholds in the code:
- **Take Profit**: 25% gain
- **Strong Profit**: 15% gain
- **Stop Loss**: -20% loss
- **High Fees Warning**: When fees > 80% of unrealized gains

### Price Cache Settings
- **Cache Duration**: 5 minutes for active use
- **Fallback Duration**: Up to 1 hour if API fails
- **Final Fallback**: $185 if no data available

## Example Workflow

```bash
# 1. Start tracking AIXBT with $500 investment
./damm-pnl aixbt 500.00

# 2. Position grows to $650, claim $25 in fees
./damm-pnl aixbt 650.00 25.00

# 3. Add more capital during a dip
./damm-pnl add-capital aixbt 200.00

# 4. Take some profit when position hits $1000
./damm-pnl take-profit aixbt 300.00

# 5. Check your portfolio
./damm-pnl list

# 6. View performance analytics
./damm-pnl summary

# 7. Eventually close the position
./damm-pnl close aixbt 1200.00 50.00
```

## Contributing

This is a personal finance tracking tool. Feel free to fork and modify for your own needs.

## Disclaimer

This tool is for tracking and analysis purposes only. It does not:
- Provide financial advice
- Execute trades
- Access your actual funds
- Guarantee accuracy of calculations

Always verify your actual positions and PnL with your exchange or wallet.

## License

MIT License - Use at your own risk for personal tracking purposes.

---

**Built for traders who value privacy and want complete control over their data.**
