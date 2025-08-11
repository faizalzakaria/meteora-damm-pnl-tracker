#!/usr/bin/env ts-node

import fs from 'fs';

interface Position {
  token: string;
  initial_value_usd: number;  // Store in USD now
  fees_claimed_usd: number;   // Store fees in USD too
  created_at: string;
  last_updated: string;
  capital_additions_usd?: number;  // Additional capital added after initial investment
  capital_reduction_usd?: number;  // Capital reduced/withdrawn from position
  total_invested_usd?: number;     // Total capital invested (initial + additions - reductions)
}

interface PnlData {
  // Primary USD values
  unrealized_pnl_usd: number;
  realized_pnl_usd: number;
  total_pnl_usd: number;
  pnl_percentage: number;
  initial_value_usd: number;
  current_value_usd: number;
  total_invested_usd: number;  // Total capital invested
  // SOL equivalents (calculated)
  unrealized_pnl_sol: number;
  realized_pnl_sol: number;
  total_pnl_sol: number;
  initial_value_sol: number;
  current_value_sol: number;
  total_invested_sol: number;  // Total capital invested in SOL
}

interface Suggestion {
  action: 'HOLD' | 'TOP_UP' | 'REDUCE' | 'TAKE_PROFIT' | 'STOP_LOSS';
  reason: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

const DATA_FILE = 'damm_positions.json';

// ANSI color codes
const COLORS = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  
  // Text colors
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',
  GRAY: '\x1b[90m',
  
  // Bright colors
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_YELLOW: '\x1b[93m',
  BRIGHT_BLUE: '\x1b[94m',
  BRIGHT_MAGENTA: '\x1b[95m',
  BRIGHT_CYAN: '\x1b[96m',
  
  // Background colors
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m'
};

// Suggestion thresholds (configurable)
const THRESHOLDS = {
  TAKE_PROFIT: 25, // 25% profit
  STRONG_PROFIT: 15, // 15% profit  
  MODERATE_PROFIT: 5, // 5% profit
  BREAK_EVEN: 0, // 0% (break even)
  MODERATE_LOSS: -10, // -10% loss
  STOP_LOSS: -20, // -20% loss
  HIGH_FEES_RATIO: 0.8 // 80% of unrealized profit
};

// Color helper functions
function colorText(text: string, color: string, bold: boolean = false): string {
  const style = bold ? COLORS.BOLD + color : color;
  return `${style}${text}${COLORS.RESET}`;
}

function formatSOLValue(value: number): string {
  if (value > 0) {
    return colorText(`+${value.toFixed(4)} SOL`, COLORS.BRIGHT_GREEN, true);
  } else if (value < 0) {
    return colorText(`${value.toFixed(4)} SOL`, COLORS.BRIGHT_RED, true);
  } else {
    return colorText(`${value.toFixed(4)} SOL`, COLORS.GRAY);
  }
}

function formatPercentage(percent: number): string {
  if (percent > 0) {
    return colorText(`(+${percent.toFixed(2)}%)`, COLORS.BRIGHT_GREEN, true);
  } else if (percent < 0) {
    return colorText(`(${percent.toFixed(2)}%)`, COLORS.BRIGHT_RED, true);
  } else {
    return colorText(`(${percent.toFixed(2)}%)`, COLORS.GRAY);
  }
}

function formatBigPercentage(percent: number): string {
  const percentStr = percent.toFixed(2) + '%';
  if (percent > 0) {
    return colorText(`+${percentStr}`, COLORS.BG_GREEN + COLORS.WHITE, true);
  } else if (percent < 0) {
    return colorText(`${percentStr}`, COLORS.BG_RED + COLORS.WHITE, true);
  } else {
    return colorText(`${percentStr}`, COLORS.BG_YELLOW + COLORS.WHITE, true);
  }
}

function formatUSDValue(value: number): string {
  if (value > 0) {
    return colorText(`+$${value.toFixed(2)}`, COLORS.BRIGHT_GREEN, true);
  } else if (value < 0) {
    return colorText(`-$${Math.abs(value).toFixed(2)}`, COLORS.BRIGHT_RED, true);
  } else {
    return colorText(`$${value.toFixed(2)}`, COLORS.GRAY);
  }
}

function formatUSDNeutral(value: number): string {
  return colorText(`$${value.toFixed(2)}`, COLORS.BRIGHT_YELLOW, true);
}

// Get SOL price in USD
async function getSOLPriceUSD(): Promise<number> {
  try {
    // Try CoinGecko first (more reliable for major tokens)
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      signal: AbortSignal.timeout(5000)
    });
    
    if (response.ok) {
      const data = await response.json();
      const price = data.solana?.usd;
      
      if (price) {
        return price;
      }
    }
    
    return 0;
  } catch (error) {
    console.warn(`Could not get SOL price: ${error}`);
    return 0;
  }
}

function loadPositions(): Record<string, Position> {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return {};
    }
  }
  return {};
}

function savePositions(positions: Record<string, Position>): void {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(positions, null, 2));
  } catch (error) {
    console.error(`Error saving data: ${error}`);
    process.exit(1);
  }
}

async function initializePosition(token: string, initialValueUSD: number): Promise<Position> {
  const now = new Date().toISOString();
  return {
    token,
    initial_value_usd: initialValueUSD,
    fees_claimed_usd: 0,
    created_at: now,
    last_updated: now,
    capital_additions_usd: 0,
    capital_reduction_usd: 0,
    total_invested_usd: initialValueUSD
  };
}

async function calculatePnl(position: Position, currentValueUSD: number): Promise<PnlData> {
  // Initialize fields if they don't exist (backward compatibility)
  const capitalAdditions = position.capital_additions_usd || 0;
  const capitalReductions = position.capital_reduction_usd || 0;
  const totalInvestedUSD = position.initial_value_usd + capitalAdditions - capitalReductions;
  
  // Values are stored in USD, calculations are in USD
  const unrealizedPnlUSD = currentValueUSD - totalInvestedUSD; // Compare against total invested, not just initial
  const realizedPnlUSD = position.fees_claimed_usd;
  const totalPnlUSD = unrealizedPnlUSD + realizedPnlUSD;
  const pnlPercentage = totalInvestedUSD > 0 ? (totalPnlUSD / totalInvestedUSD) * 100 : 0; // Percentage against total invested

  // Get SOL price for SOL equivalents calculation
  const solPriceUSD = await getSOLPriceUSD();

  // Convert USD values to SOL equivalents
  const unrealizedPnlSOL = solPriceUSD > 0 ? unrealizedPnlUSD / solPriceUSD : 0;
  const realizedPnlSOL = solPriceUSD > 0 ? realizedPnlUSD / solPriceUSD : 0;
  const totalPnlSOL = solPriceUSD > 0 ? totalPnlUSD / solPriceUSD : 0;
  const currentValueSOL = solPriceUSD > 0 ? currentValueUSD / solPriceUSD : 0;
  const initialValueSOL = solPriceUSD > 0 ? position.initial_value_usd / solPriceUSD : 0;
  const totalInvestedSOL = solPriceUSD > 0 ? totalInvestedUSD / solPriceUSD : 0;

  return {
    // Primary USD values
    unrealized_pnl_usd: unrealizedPnlUSD,
    realized_pnl_usd: realizedPnlUSD,
    total_pnl_usd: totalPnlUSD,
    pnl_percentage: pnlPercentage,
    initial_value_usd: position.initial_value_usd,
    current_value_usd: currentValueUSD,
    total_invested_usd: totalInvestedUSD,
    // SOL equivalents (calculated)
    unrealized_pnl_sol: unrealizedPnlSOL,
    realized_pnl_sol: realizedPnlSOL,
    total_pnl_sol: totalPnlSOL,
    initial_value_sol: initialValueSOL,
    current_value_sol: currentValueSOL,
    total_invested_sol: totalInvestedSOL
  };
}

function generateSuggestion(position: Position, pnlData: PnlData): Suggestion {
  const pnlPercent = pnlData.pnl_percentage;
  const unrealizedPnlUSD = pnlData.unrealized_pnl_usd;
  const realizedPnlUSD = pnlData.realized_pnl_usd;
  const daysOpen = Math.floor((Date.now() - new Date(position.created_at).getTime()) / (1000 * 60 * 60 * 24));
  
  // High fees relative to unrealized profit (risk of giving back gains)
  if (unrealizedPnlUSD > 0 && realizedPnlUSD / unrealizedPnlUSD > THRESHOLDS.HIGH_FEES_RATIO) {
    return {
      action: 'TAKE_PROFIT',
      reason: `High fees earned (${((realizedPnlUSD / unrealizedPnlUSD) * 100).toFixed(0)}% of unrealized gains). Secure profits before market turns.`,
      confidence: 'HIGH'
    };
  }
  
  // Take profit scenarios
  if (pnlPercent >= THRESHOLDS.TAKE_PROFIT) {
    return {
      action: 'TAKE_PROFIT',
      reason: `Excellent ${pnlPercent.toFixed(1)}% return! Consider taking partial profits to secure gains.`,
      confidence: 'HIGH'
    };
  }
  
  if (pnlPercent >= THRESHOLDS.STRONG_PROFIT) {
    return {
      action: 'REDUCE',
      reason: `Strong ${pnlPercent.toFixed(1)}% profit. Consider reducing position size to lock in gains while maintaining exposure.`,
      confidence: 'MEDIUM'
    };
  }
  
  // Stop loss scenarios  
  if (pnlPercent <= THRESHOLDS.STOP_LOSS) {
    return {
      action: 'STOP_LOSS',
      reason: `Position down ${Math.abs(pnlPercent).toFixed(1)}%. Consider cutting losses to preserve capital.`,
      confidence: 'HIGH'
    };
  }
  
  if (pnlPercent <= THRESHOLDS.MODERATE_LOSS) {
    if (daysOpen > 30) {
      return {
        action: 'REDUCE',
        reason: `Position down ${Math.abs(pnlPercent).toFixed(1)}% for ${daysOpen} days. Consider reducing exposure or reevaluating thesis.`,
        confidence: 'MEDIUM'
      };
    } else {
      return {
        action: 'HOLD',
        reason: `Down ${Math.abs(pnlPercent).toFixed(1)}% but position is recent (${daysOpen} days). Monitor closely.`,
        confidence: 'LOW'
      };
    }
  }
  
  // Top up scenarios
  if (pnlPercent >= THRESHOLDS.BREAK_EVEN && pnlPercent < THRESHOLDS.MODERATE_PROFIT) {
    if (realizedPnlUSD > 0) {
      return {
        action: 'TOP_UP',
        reason: `Near breakeven with $${realizedPnlUSD.toFixed(2)} in fees earned. Position showing promise - consider increasing.`,
        confidence: 'MEDIUM'
      };
    } else {
      return {
        action: 'HOLD',
        reason: `Position near breakeven. Monitor for clear direction before making changes.`,
        confidence: 'LOW'
      };
    }
  }
  
  // Moderate profit - hold and monitor
  if (pnlPercent >= THRESHOLDS.MODERATE_PROFIT && pnlPercent < THRESHOLDS.STRONG_PROFIT) {
    return {
      action: 'HOLD',
      reason: `Good ${pnlPercent.toFixed(1)}% profit with momentum. Hold position and monitor for further gains.`,
      confidence: 'MEDIUM'
    };
  }
  
  // Default hold
  return {
    action: 'HOLD',
    reason: `Position performing as expected. Continue monitoring market conditions.`,
    confidence: 'LOW'
  };
}

async function displayPositionInfo(token: string, position: Position, currentValueUSD: number): Promise<void> {
  try {
    const pnlData = await calculatePnl(position, currentValueUSD);
    const suggestion = generateSuggestion(position, pnlData);
    const daysOpen = Math.floor((Date.now() - new Date(position.created_at).getTime()) / (1000 * 60 * 60 * 24));
    
    console.log(`\n${colorText('='.repeat(60), COLORS.CYAN)}`);
    console.log(`${colorText('TOKEN:', COLORS.BOLD + COLORS.WHITE)} ${colorText(token.toUpperCase(), COLORS.BRIGHT_CYAN, true)}`);
    console.log(`${colorText('='.repeat(60), COLORS.CYAN)}`);
    
    // Show USD values with SOL equivalents in parentheses
    const capitalAdditions = (position.capital_additions_usd || 0);
    const capitalReductions = (position.capital_reduction_usd || 0);
    
    console.log(`${colorText('Initial Position Value:', COLORS.WHITE)} ${formatUSDNeutral(pnlData.initial_value_usd)} ${colorText(`(${(pnlData.initial_value_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
    
    if (capitalAdditions > 0 || capitalReductions > 0) {
      const solPrice = await getSOLPriceUSD();
      
      if (capitalAdditions > 0) {
        const capitalAdditionsSOL = solPrice > 0 ? capitalAdditions / solPrice : 0;
        console.log(`${colorText('Capital Additions:', COLORS.WHITE)} ${formatUSDNeutral(capitalAdditions)} ${colorText(`(${capitalAdditionsSOL.toFixed(4)} SOL)`, COLORS.GRAY)}`);
      }
      
      if (capitalReductions > 0) {
        const capitalReductionsSOL = solPrice > 0 ? capitalReductions / solPrice : 0;
        console.log(`${colorText('Capital Reductions:', COLORS.WHITE)} ${colorText(`-$${capitalReductions.toFixed(2)}`, COLORS.BRIGHT_RED)} ${colorText(`(-${capitalReductionsSOL.toFixed(4)} SOL)`, COLORS.GRAY)}`);
      }
      
      console.log(`${colorText('Total Invested Capital:', COLORS.BOLD + COLORS.WHITE)} ${formatUSDNeutral(pnlData.total_invested_usd)} ${colorText(`(${(pnlData.total_invested_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
    }
    
    console.log(`${colorText('Current Position Value:', COLORS.WHITE)} ${colorText(`$${currentValueUSD.toFixed(2)}`, COLORS.BRIGHT_YELLOW, true)} ${colorText(`(${(pnlData.current_value_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
    console.log(`${colorText('Fees Claimed (Realized):', COLORS.WHITE)} ${formatUSDNeutral(pnlData.realized_pnl_usd)} ${colorText(`(${(pnlData.realized_pnl_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
  console.log(``);
  
  // Show PNL in USD with SOL equivalents in parentheses
  console.log(`${colorText('Unrealized PNL:', COLORS.WHITE)} ${formatUSDValue(pnlData.unrealized_pnl_usd)} ${colorText(`(${formatSOLValue(pnlData.unrealized_pnl_sol || 0)})`, COLORS.GRAY)}`);
  console.log(`${colorText('Realized PNL:', COLORS.WHITE)} ${formatUSDValue(pnlData.realized_pnl_usd)} ${colorText(`(${formatSOLValue(pnlData.realized_pnl_sol || 0)})`, COLORS.GRAY)}`);
  console.log(`${colorText('Total PNL:', COLORS.BOLD + COLORS.WHITE)} ${formatUSDValue(pnlData.total_pnl_usd)} ${colorText(`(${formatSOLValue(pnlData.total_pnl_sol || 0)})`, COLORS.GRAY)}`);
  console.log(``);
  
  // Prominent PNL Percentage Display
  console.log(`${colorText('━'.repeat(60), COLORS.CYAN)}`);
  console.log(`${colorText('                    📊 PNL PERCENTAGE 📊', COLORS.BOLD + COLORS.WHITE)}`);
  console.log(`${colorText('                        ', COLORS.WHITE)}${formatBigPercentage(pnlData.pnl_percentage)}`);
  console.log(`${colorText('━'.repeat(60), COLORS.CYAN)}`);
  console.log(``);
  
  console.log(`${colorText('Position opened:', COLORS.GRAY)} ${colorText(`${daysOpen} day${daysOpen !== 1 ? 's' : ''} ago`, COLORS.WHITE)}`);
  console.log(`${colorText('Last updated:', COLORS.GRAY)} ${colorText(position.last_updated.substring(0, 19), COLORS.WHITE)}`);
  console.log(``);
  
  // Display suggestion with appropriate styling
  const actionEmoji = suggestion.action === 'TOP_UP' ? '🟢' : 
                     suggestion.action === 'REDUCE' || suggestion.action === 'STOP_LOSS' ? '🔴' :
                     suggestion.action === 'TAKE_PROFIT' ? '🟡' : '⚪';
  
  const actionColor = suggestion.action === 'TOP_UP' ? COLORS.BRIGHT_GREEN : 
                     suggestion.action === 'REDUCE' || suggestion.action === 'STOP_LOSS' ? COLORS.BRIGHT_RED :
                     suggestion.action === 'TAKE_PROFIT' ? COLORS.BRIGHT_YELLOW : COLORS.WHITE;
  
  const confidenceIndicator = suggestion.confidence === 'HIGH' ? '🔥' :
                             suggestion.confidence === 'MEDIUM' ? '⚡' : '💭';
  
  const confidenceColor = suggestion.confidence === 'HIGH' ? COLORS.BRIGHT_RED :
                         suggestion.confidence === 'MEDIUM' ? COLORS.BRIGHT_YELLOW : COLORS.GRAY;
                             
  console.log(`${actionEmoji} ${colorText('SUGGESTION:', COLORS.BOLD + COLORS.WHITE)} ${colorText(suggestion.action, actionColor, true)} ${confidenceIndicator}`);
  console.log(`${colorText(suggestion.reason, COLORS.WHITE)}`);
  console.log(`${colorText('Confidence:', COLORS.GRAY)} ${colorText(suggestion.confidence, confidenceColor, true)}`);
  console.log(`${colorText('='.repeat(60), COLORS.CYAN)}`);
  } catch (error) {
    console.error('DEBUG: Error in displayPositionInfo:', error);
    throw error;
  }
}

function listAllPositions(positions: Record<string, Position>): void {
  const tokens = Object.keys(positions);
  if (tokens.length === 0) {
    console.log(colorText('No positions found.', COLORS.GRAY));
    return;
  }

  console.log(`\n${colorText('All Positions:', COLORS.BOLD + COLORS.WHITE)}`);
  console.log(colorText('==============', COLORS.CYAN));
  tokens.forEach(token => {
    const position = positions[token];
    const capitalAdditions = position.capital_additions_usd || 0;
    const capitalReductions = position.capital_reduction_usd || 0;
    const totalInvested = position.initial_value_usd + capitalAdditions - capitalReductions;
    
    let displayText = `${colorText(token.toUpperCase(), COLORS.BRIGHT_CYAN, true)}: `;
    
    if (capitalAdditions > 0 || capitalReductions > 0) {
      displayText += `${formatUSDNeutral(totalInvested)} ${colorText('(initial:', COLORS.GRAY)} ${formatUSDNeutral(position.initial_value_usd)}`;
      
      if (capitalAdditions > 0) {
        displayText += ` ${colorText('+ added:', COLORS.GRAY)} ${formatUSDNeutral(capitalAdditions)}`;
      }
      
      if (capitalReductions > 0) {
        displayText += ` ${colorText('- reduced:', COLORS.GRAY)} ${formatUSDNeutral(capitalReductions)}`;
      }
      
      displayText += `${colorText(')', COLORS.GRAY)}`;
    } else {
      displayText += `${formatUSDNeutral(position.initial_value_usd)}`;
    }
    
    displayText += ` ${colorText('(fees:', COLORS.GRAY)} ${formatUSDNeutral(position.fees_claimed_usd)}${colorText(')', COLORS.GRAY)}`;
    
    console.log(displayText);
  });
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage:');
    console.log('  ./damm-pnl <token_name> <current_position_value_usd> [fees_claimed_usd]');
    console.log('  ./damm-pnl add-capital <token_name> <additional_capital_usd>');
    console.log('  ./damm-pnl reduce-capital <token_name> <capital_to_reduce_usd>');
    console.log('  ./damm-pnl remove <token_name>');
    console.log('  ./damm-pnl reset <token_name> <new_initial_value_usd>');
    console.log('  ./damm-pnl fix');
    console.log('  ./damm-pnl clean');
    console.log('  ./damm-pnl list');
    console.log('');
    console.log('Examples:');
    console.log('  ./damm-pnl aixbt 249.07    # Position value in USD');
    console.log('  ./damm-pnl aixbt 275.50 12.30    # With fees claimed in USD');
    console.log('  ./damm-pnl add-capital aixbt 360.00    # Add $360 more capital');
    console.log('  ./damm-pnl reduce-capital aixbt 100.00    # Reduce capital by $100');
    console.log('  ./damm-pnl remove aixbt');
    console.log('  ./damm-pnl reset aixbt 200.00    # Reset to $200 USD');
    console.log('  ./damm-pnl fix   # Convert old SOL-based positions to USD');
    console.log('  ./damm-pnl clean  # Remove positions with incorrect data');
    console.log('  ./damm-pnl list');
    process.exit(1);
  }

  const command = args[0].toLowerCase();
  const positions = loadPositions();

  if (command === 'list') {
    listAllPositions(positions);
    return;
  }

  if (command === 'clean') {
    // Clean up positions with unrealistic values (likely stored incorrectly)
    const cleanedPositions: Record<string, Position> = {};
    let cleanedCount = 0;
    
    for (const [key, position] of Object.entries(positions)) {
      // Skip positions with unrealistic initial values 
      const initialValue = position.initial_value_usd || (position as any).initial_value || 0;
      if (initialValue > 10000) { // More than $10,000 is likely incorrect data
        console.log(colorText(`🗑️  Removed ${key.toUpperCase()} with unrealistic value: $${initialValue.toFixed(2)}`, COLORS.YELLOW));
        cleanedCount++;
      } else {
        cleanedPositions[key] = position;
      }
    }
    
    savePositions(cleanedPositions);
    console.log(colorText(`✅ Cleaned ${cleanedCount} positions with incorrect data`, COLORS.BRIGHT_GREEN));
    
    if (Object.keys(cleanedPositions).length > 0) {
      console.log('\nRemaining positions:');
      listAllPositions(cleanedPositions);
    }
    return;
  }

  if (command === 'fix') {
    // Fix positions where USD values were stored as SOL
    const solPriceUSD = await getSOLPriceUSD();
    if (solPriceUSD === 0) {
      console.error(colorText('❌ Could not get SOL price for conversion', COLORS.BRIGHT_RED));
      return;
    }

    let fixedCount = 0;
    console.log(colorText(`💰 SOL price: $${solPriceUSD.toFixed(2)}`, COLORS.BRIGHT_CYAN));
    console.log(colorText('🔧 Converting USD values stored as SOL...', COLORS.BRIGHT_CYAN));

    for (const [key, position] of Object.entries(positions)) {
      // Check if this is an old SOL-based position that needs conversion to USD
      const hasOldFormat = (position as any).initial_value !== undefined && position.initial_value_usd === undefined;
      
      if (hasOldFormat) {
        const oldPosition = position as any;
        const oldValue = oldPosition.initial_value;
        const oldFees = oldPosition.fees_claimed || 0;
        
        // Convert from SOL to USD and update to new format
        position.initial_value_usd = oldValue * solPriceUSD;
        position.fees_claimed_usd = oldFees * solPriceUSD;
        
        // Remove old fields
        delete (position as any).initial_value;
        delete (position as any).fees_claimed;
        
        console.log(colorText(`🔄 ${key.toUpperCase()}: ${oldValue.toFixed(4)} SOL → $${position.initial_value_usd.toFixed(2)}`, COLORS.YELLOW));
        if (oldFees > 0) {
          console.log(colorText(`   Fees: ${oldFees.toFixed(4)} SOL → $${position.fees_claimed_usd.toFixed(2)}`, COLORS.GRAY));
        }
        
        fixedCount++;
      }
    }
    
    if (fixedCount > 0) {
      savePositions(positions);
      console.log(colorText(`✅ Fixed ${fixedCount} positions with USD values`, COLORS.BRIGHT_GREEN));
    } else {
      console.log(colorText('No positions needed fixing.', COLORS.GRAY));
    }
    return;
  }

  if (command === 'remove') {
    if (args.length < 2) {
      console.error('Usage: ./damm-pnl remove <token_name>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    if (!positions[token]) {
      console.error(`Position for ${token.toUpperCase()} not found.`);
      process.exit(1);
    }
    
    delete positions[token];
    savePositions(positions);
    console.log(colorText(`✅ Position for ${token.toUpperCase()} has been removed.`, COLORS.BRIGHT_GREEN));
    return;
  }

  if (command === 'reset') {
    if (args.length < 3) {
      console.error('Usage: ./damm-pnl reset <token_name> <new_initial_value_usd>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const newInitialValue = parseFloat(args[2]);
    
    if (isNaN(newInitialValue)) {
      console.error(`Error: New initial value must be a number, got '${args[2]}'`);
      process.exit(1);
    }
    
    if (!positions[token]) {
      console.error(`Position for ${token.toUpperCase()} not found.`);
      process.exit(1);
    }
    
    const oldPosition = positions[token];
    positions[token] = await initializePosition(token, newInitialValue);
    savePositions(positions);
    console.log(colorText(`✅ Position for ${token.toUpperCase()} has been reset.`, COLORS.BRIGHT_GREEN));
    const oldValue = oldPosition.initial_value_usd || (oldPosition as any).initial_value || 0;
    console.log(`${colorText('Old initial value:', COLORS.GRAY)} ${formatUSDNeutral(oldValue)} ${colorText('->', COLORS.GRAY)} ${formatUSDNeutral(newInitialValue)}`);
    return;
  }

  if (command === 'add-capital') {
    if (args.length < 3) {
      console.error('Usage: ./damm-pnl add-capital <token_name> <additional_capital_usd>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const additionalCapital = parseFloat(args[2]);
    
    if (isNaN(additionalCapital)) {
      console.error(`Error: Additional capital must be a number, got '${args[2]}'`);
      process.exit(1);
    }
    
    if (additionalCapital <= 0) {
      console.error(`Error: Additional capital must be positive, got '${additionalCapital}'`);
      process.exit(1);
    }
    
    if (!positions[token]) {
      console.error(`Position for ${token.toUpperCase()} not found. Create a position first.`);
      process.exit(1);
    }
    
    const position = positions[token];
    
    // Initialize fields if they don't exist (backward compatibility)
    if (position.capital_additions_usd === undefined) {
      position.capital_additions_usd = 0;
    }
    if (position.capital_reduction_usd === undefined) {
      position.capital_reduction_usd = 0;
    }
    
    // Add the capital
    position.capital_additions_usd += additionalCapital;
    // Update total invested: initial + additions - reductions
    position.total_invested_usd = position.initial_value_usd + position.capital_additions_usd - position.capital_reduction_usd;
    position.last_updated = new Date().toISOString();
    
    savePositions(positions);
    console.log(colorText(`💰 Added $${additionalCapital.toFixed(2)} capital to ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
    console.log(`${colorText('Total invested:', COLORS.GRAY)} ${formatUSDNeutral(position.total_invested_usd)} ${colorText('(initial:', COLORS.GRAY)} ${formatUSDNeutral(position.initial_value_usd)} ${colorText('+ additions:', COLORS.GRAY)} ${formatUSDNeutral(position.capital_additions_usd)}${colorText(')', COLORS.GRAY)}`);
    return;
  }

  if (command === 'reduce-capital') {
    if (args.length < 3) {
      console.error('Usage: ./damm-pnl reduce-capital <token_name> <capital_to_reduce_usd>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const capitalToReduce = parseFloat(args[2]);
    
    if (isNaN(capitalToReduce)) {
      console.error(`Error: Capital to reduce must be a number, got '${args[2]}'`);
      process.exit(1);
    }
    
    if (capitalToReduce <= 0) {
      console.error(`Error: Capital to reduce must be positive, got '${capitalToReduce}'`);
      process.exit(1);
    }
    
    if (!positions[token]) {
      console.error(`Position for ${token.toUpperCase()} not found.`);
      process.exit(1);
    }
    
    const position = positions[token];
    
    // Initialize fields if they don't exist (backward compatibility)
    if (position.capital_additions_usd === undefined) {
      position.capital_additions_usd = 0;
    }
    if (position.capital_reduction_usd === undefined) {
      position.capital_reduction_usd = 0;
    }
    
    // Calculate current total invested: initial + additions - reductions
    const currentTotalInvested = position.initial_value_usd + position.capital_additions_usd - position.capital_reduction_usd;
    
    // Check if we can reduce the capital
    if (capitalToReduce > currentTotalInvested) {
      console.error(`Error: Cannot reduce $${capitalToReduce.toFixed(2)} from total invested capital of $${currentTotalInvested.toFixed(2)}`);
      process.exit(1);
    }
    
    // Don't allow reducing total invested below zero
    if ((currentTotalInvested - capitalToReduce) < 0) {
      console.error(`Error: Cannot reduce total invested capital below zero`);
      console.error(`Maximum you can reduce: $${currentTotalInvested.toFixed(2)}`);
      process.exit(1);
    }
    
    // Add to capital reductions and update total invested
    const oldTotalInvested = currentTotalInvested;
    position.capital_reduction_usd += capitalToReduce;
    const newTotalInvested = position.initial_value_usd + position.capital_additions_usd - position.capital_reduction_usd;
    position.total_invested_usd = newTotalInvested;
    position.last_updated = new Date().toISOString();
    
    savePositions(positions);
    console.log(colorText(`📉 Reduced $${capitalToReduce.toFixed(2)} capital from ${token.toUpperCase()}`, COLORS.BRIGHT_YELLOW));
    console.log(`${colorText('Total invested:', COLORS.GRAY)} ${formatUSDNeutral(oldTotalInvested)} ${colorText('→', COLORS.GRAY)} ${formatUSDNeutral(newTotalInvested)}`);
    console.log(`${colorText('Capital breakdown:', COLORS.GRAY)} ${colorText('initial:', COLORS.GRAY)} ${formatUSDNeutral(position.initial_value_usd)} ${colorText('+ additions:', COLORS.GRAY)} ${formatUSDNeutral(position.capital_additions_usd)} ${colorText('- reductions:', COLORS.GRAY)} ${formatUSDNeutral(position.capital_reduction_usd)}`);
    return;
  }

  const token = command;
  if (args.length < 2) {
    console.error('Usage: ./damm-pnl <token_name> <current_position_value_usd> [fees_claimed_usd]');
    process.exit(1);
  }

  const currentValueUSD = parseFloat(args[1]);
  
  if (isNaN(currentValueUSD)) {
    console.error(`Error: Current position value must be a number, got '${args[1]}'`);
    process.exit(1);
  }

  let feesToAddUSD = 0;
  if (args.length >= 3) {
    feesToAddUSD = parseFloat(args[2]);
    if (isNaN(feesToAddUSD)) {
      console.error(`Error: Fees claimed must be a number, got '${args[2]}'`);
      process.exit(1);
    }
  }

  if (!positions[token]) {
    positions[token] = await initializePosition(token, currentValueUSD);
    console.log(colorText(`🚀 New position created for ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
  } else {
    positions[token].fees_claimed_usd += feesToAddUSD;
    positions[token].last_updated = new Date().toISOString();
    
    if (feesToAddUSD > 0) {
      console.log(colorText(`💰 Added $${feesToAddUSD.toFixed(2)} in fees to ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
    }
  }

  savePositions(positions);
  await displayPositionInfo(token, positions[token], currentValueUSD);
}

if (require.main === module) {
  main().catch(error => {
    console.error(colorText(`❌ Error: ${error}`, COLORS.BRIGHT_RED));
    process.exit(1);
  });
}