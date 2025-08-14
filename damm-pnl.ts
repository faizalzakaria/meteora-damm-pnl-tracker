#!/usr/bin/env ts-node

import fs from 'fs';

interface Position {
  id: string;                      // Unique position ID
  token: string;
  initial_value_usd: number;  // Store in USD now
  fees_claimed_usd: number;   // Store fees in USD too
  created_at: string;
  last_updated: string;
  capital_additions_usd?: number;  // Additional capital added after initial investment
  withdrawn_usd?: number;          // Total amount withdrawn from position
  total_invested_usd?: number;     // Total capital invested (initial + additions - reductions)
  // Closure data
  closed_at?: string;              // When position was closed
  exit_value_usd?: number;         // Final exit value in USD
  final_pnl_usd?: number;          // Final total PNL at closure
  final_pnl_percentage?: number;   // Final PNL percentage at closure
  is_closed?: boolean;             // Whether position is closed
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

// Simple cache for SOL price to avoid rate limiting
let solPriceCache: { price: number; timestamp: number } | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minute cache
const PRICE_CACHE_FILE = 'sol_price_cache.json';

// Load cached price from file
function loadPriceCache(): { price: number; timestamp: number } | null {
  if (fs.existsSync(PRICE_CACHE_FILE)) {
    try {
      const data = fs.readFileSync(PRICE_CACHE_FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return null;
}

// Save price cache to file
function savePriceCache(cache: { price: number; timestamp: number }): void {
  try {
    fs.writeFileSync(PRICE_CACHE_FILE, JSON.stringify(cache));
  } catch (error) {
    // Ignore file save errors
  }
}

// Get SOL price in USD
async function getSOLPriceUSD(): Promise<number> {
  // Check in-memory cache first
  if (solPriceCache && (Date.now() - solPriceCache.timestamp) < CACHE_DURATION) {
    return solPriceCache.price;
  }
  
  // Check file cache
  if (!solPriceCache) {
    solPriceCache = loadPriceCache();
    if (solPriceCache && (Date.now() - solPriceCache.timestamp) < CACHE_DURATION) {
      return solPriceCache.price;
    }
  }
  
  try {
    // Try CoinGecko API
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      signal: AbortSignal.timeout(10000)
    });
    
    if (response.ok) {
      const data = await response.json();
      const price = data.solana?.usd;
      
      if (price && price > 0) {
        // Cache the price in memory and file
        solPriceCache = { price, timestamp: Date.now() };
        savePriceCache(solPriceCache);
        return price;
      }
    }
    
    // API failed - use any available cached data (even if old)
    if (solPriceCache && solPriceCache.price > 0) {
      const ageMinutes = Math.round((Date.now() - solPriceCache.timestamp) / (60 * 1000));
      if (ageMinutes < 60) { // Use cached data up to 1 hour old
        return solPriceCache.price;
      }
    }
    
    // Final fallback
    const fallbackPrice = 185;
    return fallbackPrice;
  } catch (error) {
    // Use any cached price if available
    if (solPriceCache && solPriceCache.price > 0) {
      return solPriceCache.price;
    }
    
    // Final fallback
    return 185;
  }
}

function loadPositions(): Record<string, Position> {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      const positions = JSON.parse(data);
      
      // Migrate old format (token-keyed) to new format (ID-keyed)
      const migratedPositions: Record<string, Position> = {};
      
      for (const [key, position] of Object.entries(positions)) {
        if (typeof position === 'object' && position !== null) {
          const pos = position as any;
          
          // If this position doesn't have an ID, it's old format
          if (!pos.id) {
            // Generate ID from token and timestamp for migration
            pos.id = `${key}_${new Date(pos.created_at || Date.now()).getTime()}`;
            pos.token = key;
          }
          
          // Migrate to simplified withdraw model
          if (pos.capital_reduction_usd !== undefined) {
            pos.withdrawn_usd = pos.capital_reduction_usd + (pos.profit_taken_usd || 0);
            delete pos.capital_reduction_usd;
            delete pos.profit_taken_usd;
          }
          
          // Fix total_invested_usd to be initial + additions
          if (pos.initial_value_usd !== undefined) {
            const capitalAdditions = pos.capital_additions_usd || 0;
            pos.total_invested_usd = pos.initial_value_usd + capitalAdditions;
          }
          
          migratedPositions[pos.id] = pos as Position;
        }
      }
      
      return migratedPositions;
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

// Helper functions for position management
function findActivePosition(positions: Record<string, Position>, token: string): Position | null {
  for (const position of Object.values(positions)) {
    if (position.token.toLowerCase() === token.toLowerCase() && !position.is_closed) {
      return position;
    }
  }
  return null;
}

function findClosedPositions(positions: Record<string, Position>, token: string): Position[] {
  return Object.values(positions).filter(
    pos => pos.token.toLowerCase() === token.toLowerCase() && pos.is_closed
  );
}

function generatePositionId(token: string): string {
  return `${token.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function initializePosition(token: string, initialValueUSD: number): Promise<Position> {
  const now = new Date().toISOString();
  return {
    id: generatePositionId(token),
    token,
    initial_value_usd: initialValueUSD,
    fees_claimed_usd: 0,
    created_at: now,
    last_updated: now,
    capital_additions_usd: 0,
    withdrawn_usd: 0,
    total_invested_usd: initialValueUSD
  };
}

async function calculatePnl(position: Position, currentValueUSD: number): Promise<PnlData> {
  // Initialize fields if they don't exist (backward compatibility)
  const capitalAdditions = position.capital_additions_usd || 0;
  const withdrawn = position.withdrawn_usd || 0;
  
  // Total invested stays constant: initial + additions
  const totalInvestedUSD = position.initial_value_usd + capitalAdditions;
  
  // Amount still invested = total invested - amount withdrawn
  const currentlyInvestedUSD = totalInvestedUSD - withdrawn;
  
  // Total value received: current position + withdrawn + fees
  const totalValueUSD = currentValueUSD + withdrawn + position.fees_claimed_usd;
  
  // Total PnL is total value minus total invested
  const totalPnlUSD = totalValueUSD - totalInvestedUSD;
  
  // Unrealized PnL is current position value minus what's still invested
  const unrealizedPnlUSD = currentValueUSD - currentlyInvestedUSD;
  
  // Realized PnL is withdrawn + fees
  const realizedPnlUSD = withdrawn + position.fees_claimed_usd;
  
  const pnlPercentage = totalInvestedUSD > 0 ? (totalPnlUSD / totalInvestedUSD) * 100 : 0;

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
  // Only trigger this if unrealized gains are meaningful (>$10) to avoid false positives
  if (unrealizedPnlUSD > 10 && realizedPnlUSD / unrealizedPnlUSD > THRESHOLDS.HIGH_FEES_RATIO) {
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
    const withdrawn = (position.withdrawn_usd || 0);
    
    console.log(`${colorText('Initial Position Value:', COLORS.WHITE)} ${formatUSDNeutral(pnlData.initial_value_usd)} ${colorText(`(${(pnlData.initial_value_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
    
    if (capitalAdditions > 0) {
      const solPrice = await getSOLPriceUSD();
      const capitalAdditionsSOL = solPrice > 0 ? capitalAdditions / solPrice : 0;
      console.log(`${colorText('Capital Additions:', COLORS.WHITE)} ${formatUSDNeutral(capitalAdditions)} ${colorText(`(${capitalAdditionsSOL.toFixed(4)} SOL)`, COLORS.GRAY)}`);
    }
    
    console.log(`${colorText('Total Invested Capital:', COLORS.BOLD + COLORS.WHITE)} ${formatUSDNeutral(pnlData.total_invested_usd)} ${colorText(`(${(pnlData.total_invested_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
    
    if (withdrawn > 0) {
      const solPrice = await getSOLPriceUSD();
      const withdrawnSOL = solPrice > 0 ? withdrawn / solPrice : 0;
      console.log(`${colorText('Withdrawn:', COLORS.WHITE)} ${formatUSDValue(withdrawn)} ${colorText(`(${formatSOLValue(withdrawnSOL)})`, COLORS.GRAY)}`);
    }
    
    console.log(`${colorText('Current Position Value:', COLORS.WHITE)} ${colorText(`$${currentValueUSD.toFixed(2)}`, COLORS.BRIGHT_YELLOW, true)} ${colorText(`(${(pnlData.current_value_sol || 0).toFixed(4)} SOL)`, COLORS.GRAY)}`);
    
    // Show actual fees claimed (not total realized PnL)
    const actualFeesUSD = position.fees_claimed_usd;
    const solPrice = await getSOLPriceUSD();
    const actualFeesSOL = solPrice > 0 ? actualFeesUSD / solPrice : 0;
    console.log(`${colorText('Fees Claimed:', COLORS.WHITE)} ${formatUSDNeutral(actualFeesUSD)} ${colorText(`(${actualFeesSOL.toFixed(4)} SOL)`, COLORS.GRAY)}`);
    
    // Show current SOL price used for calculations
    const currentSOLPrice = await getSOLPriceUSD();
    if (currentSOLPrice > 0) {
      console.log(`${colorText('SOL Price (live):', COLORS.GRAY)} ${colorText(`$${currentSOLPrice.toFixed(2)}`, COLORS.BRIGHT_CYAN, true)}`);
    }
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
  const activePositions = Object.values(positions).filter(pos => !pos.is_closed);
  
  if (activePositions.length === 0) {
    console.log(colorText('No active positions found.', COLORS.GRAY));
    return;
  }

  console.log(`\n${colorText('Active Positions:', COLORS.BOLD + COLORS.WHITE)}`);
  console.log(colorText('=================', COLORS.CYAN));
  activePositions.forEach(position => {
    const capitalAdditions = position.capital_additions_usd || 0;
    const withdrawn = position.withdrawn_usd || 0;
    const totalInvested = position.initial_value_usd + capitalAdditions;
    
    let displayText = `${colorText(position.token.toUpperCase(), COLORS.BRIGHT_CYAN, true)}: `;
    
    if (capitalAdditions > 0 || withdrawn > 0) {
      displayText += `${formatUSDNeutral(totalInvested)} ${colorText('(initial:', COLORS.GRAY)} ${formatUSDNeutral(position.initial_value_usd)}`;
      
      if (capitalAdditions > 0) {
        displayText += ` ${colorText('+ added:', COLORS.GRAY)} ${formatUSDNeutral(capitalAdditions)}`;
      }
      
      if (withdrawn > 0) {
        displayText += ` ${colorText('- withdrawn:', COLORS.GRAY)} ${formatUSDNeutral(withdrawn)}`;
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

async function listClosedPositions(positions: Record<string, Position>): Promise<void> {
  const closedPositions = Object.values(positions).filter(pos => pos.is_closed);
  
  if (closedPositions.length === 0) {
    console.log(colorText('No closed positions found.', COLORS.GRAY));
    return;
  }

  // Group by token for better organization
  const closedByToken: Record<string, Position[]> = {};
  closedPositions.forEach(pos => {
    const token = pos.token.toLowerCase();
    if (!closedByToken[token]) {
      closedByToken[token] = [];
    }
    closedByToken[token].push(pos);
  });

  console.log(`\n${colorText('Closed Positions:', COLORS.BOLD + COLORS.WHITE)}`);
  console.log(colorText('=================', COLORS.CYAN));
  
  // Get SOL price once for all calculations
  const solPrice = await getSOLPriceUSD();
  
  for (const [token, positions] of Object.entries(closedByToken)) {
    console.log(`${colorText(token.toUpperCase(), COLORS.BRIGHT_CYAN, true)}:`);
    
    // Sort by closure date (newest first)
    positions.sort((a, b) => new Date(b.closed_at!).getTime() - new Date(a.closed_at!).getTime());
    
    positions.forEach((position, index) => {
      const daysOpen = Math.floor((new Date(position.closed_at!).getTime() - new Date(position.created_at).getTime()) / (1000 * 60 * 60 * 24));
      
      // Convert USD values to SOL
      const totalInvestedSOL = solPrice > 0 ? position.total_invested_usd! / solPrice : 0;
      const exitValueSOL = solPrice > 0 ? position.exit_value_usd! / solPrice : 0;
      const finalPnlSOL = solPrice > 0 ? position.final_pnl_usd! / solPrice : 0;
      
      console.log(`  ${index + 1}. ${formatUSDNeutral(position.total_invested_usd!)} ${colorText(`(${totalInvestedSOL.toFixed(4)} SOL)`, COLORS.GRAY)} → ${formatUSDNeutral(position.exit_value_usd!)} ${colorText(`(${exitValueSOL.toFixed(4)} SOL)`, COLORS.GRAY)} ${formatBigPercentage(position.final_pnl_percentage!)} ${colorText(`(${daysOpen} days)`, COLORS.GRAY)}`);
      console.log(`     ${colorText('Final PNL:', COLORS.GRAY)} ${formatUSDValue(position.final_pnl_usd!)} ${colorText(`(${formatSOLValue(finalPnlSOL)})`, COLORS.GRAY)} ${colorText('Closed:', COLORS.GRAY)} ${colorText(position.closed_at!.substring(0, 19), COLORS.WHITE)}`);
    });
  }
  console.log('');
}

function calculateSummaryStats(positions: Position[]): {
  totalInvestedUSD: number;
  totalPnlUSD: number;
  winningPositions: number;
  losingPositions: number;
  totalWinPnlUSD: number;
  totalLossPnlUSD: number;
  winRate: number;
  lossRate: number;
  overallPnlPercentage: number;
  biggestWinUSD: number;
  biggestLossUSD: number;
  biggestWinPercent: number;
  biggestLossPercent: number;
  expectedValueUSD: number;
} {
  let totalInvestedUSD = 0;
  let totalPnlUSD = 0;
  let winningPositions = 0;
  let losingPositions = 0;
  let totalWinPnlUSD = 0;
  let totalLossPnlUSD = 0;
  let biggestWinUSD = 0;
  let biggestLossUSD = 0;
  let biggestWinPercent = 0;
  let biggestLossPercent = 0;
  
  positions.forEach(position => {
    totalInvestedUSD += position.total_invested_usd || 0;
    const pnlUSD = position.final_pnl_usd || 0;
    const pnlPercent = position.final_pnl_percentage || 0;
    
    totalPnlUSD += pnlUSD;
    
    if (pnlUSD > 0) {
      winningPositions++;
      totalWinPnlUSD += pnlUSD;
      if (pnlUSD > biggestWinUSD) {
        biggestWinUSD = pnlUSD;
      }
      if (pnlPercent > biggestWinPercent) {
        biggestWinPercent = pnlPercent;
      }
    } else if (pnlUSD < 0) {
      losingPositions++;
      totalLossPnlUSD += pnlUSD;
      if (pnlUSD < biggestLossUSD) {
        biggestLossUSD = pnlUSD;
      }
      if (pnlPercent < biggestLossPercent) {
        biggestLossPercent = pnlPercent;
      }
    }
  });
  
  const totalPositions = positions.length;
  const winRate = totalPositions > 0 ? (winningPositions / totalPositions) * 100 : 0;
  const lossRate = totalPositions > 0 ? (losingPositions / totalPositions) * 100 : 0;
  const overallPnlPercentage = totalInvestedUSD > 0 ? (totalPnlUSD / totalInvestedUSD) * 100 : 0;
  
  // Calculate Expected Value (EV)
  const avgWinUSD = winningPositions > 0 ? totalWinPnlUSD / winningPositions : 0;
  const avgLossUSD = losingPositions > 0 ? totalLossPnlUSD / losingPositions : 0;
  const winProbability = totalPositions > 0 ? winningPositions / totalPositions : 0;
  const lossProbability = totalPositions > 0 ? losingPositions / totalPositions : 0;
  const expectedValueUSD = (winProbability * avgWinUSD) + (lossProbability * avgLossUSD);
  
  return {
    totalInvestedUSD,
    totalPnlUSD,
    winningPositions,
    losingPositions,
    totalWinPnlUSD,
    totalLossPnlUSD,
    winRate,
    lossRate,
    overallPnlPercentage,
    biggestWinUSD,
    biggestLossUSD,
    biggestWinPercent,
    biggestLossPercent,
    expectedValueUSD
  };
}

async function displaySummarySection(title: string, positions: Position[], solPrice: number): Promise<void> {
  if (positions.length === 0) {
    console.log(`${colorText(title, COLORS.BOLD + COLORS.WHITE)}`);
    console.log(colorText('No positions found for this period.', COLORS.GRAY));
    console.log('');
    return;
  }
  
  const stats = calculateSummaryStats(positions);
  
  console.log(`${colorText(title, COLORS.BOLD + COLORS.WHITE)}`);
  console.log(colorText('='.repeat(title.length), COLORS.CYAN));
  
  console.log(`${colorText('Total Positions:', COLORS.WHITE)} ${colorText(positions.length.toString(), COLORS.BRIGHT_CYAN, true)}`);
  console.log(`${colorText('Win Rate:', COLORS.WHITE)} ${colorText(`${stats.winRate.toFixed(1)}%`, stats.winRate >= 50 ? COLORS.BRIGHT_GREEN : COLORS.BRIGHT_RED, true)} ${colorText(`(${stats.winningPositions} wins)`, COLORS.GRAY)}`);
  console.log(`${colorText('Loss Rate:', COLORS.WHITE)} ${colorText(`${stats.lossRate.toFixed(1)}%`, stats.lossRate >= 50 ? COLORS.BRIGHT_RED : COLORS.BRIGHT_GREEN, true)} ${colorText(`(${stats.losingPositions} losses)`, COLORS.GRAY)}`);
  console.log(``);
  
  // Convert to SOL for display
  const totalInvestedSOL = solPrice > 0 ? stats.totalInvestedUSD / solPrice : 0;
  const totalPnlSOL = solPrice > 0 ? stats.totalPnlUSD / solPrice : 0;
  
  console.log(`${colorText('Total Invested:', COLORS.WHITE)} ${formatUSDNeutral(stats.totalInvestedUSD)} ${colorText(`(${totalInvestedSOL.toFixed(4)} SOL)`, COLORS.GRAY)}`);
  console.log(`${colorText('Total PNL:', COLORS.BOLD + COLORS.WHITE)} ${formatUSDValue(stats.totalPnlUSD)} ${colorText(`(${formatSOLValue(totalPnlSOL)})`, COLORS.GRAY)}`);
  console.log(`${colorText('Overall Return:', COLORS.BOLD + COLORS.WHITE)} ${formatBigPercentage(stats.overallPnlPercentage)}`);
  console.log(``);
  
  if (stats.winningPositions > 0) {
    console.log(`${colorText('Avg Win:', COLORS.WHITE)} ${formatUSDValue(stats.totalWinPnlUSD / stats.winningPositions)}`);
  }
  if (stats.losingPositions > 0) {
    console.log(`${colorText('Avg Loss:', COLORS.WHITE)} ${formatUSDValue(stats.totalLossPnlUSD / stats.losingPositions)}`);
  }
  
  // Show Expected Value
  const evColor = stats.expectedValueUSD > 0 ? COLORS.BRIGHT_GREEN : stats.expectedValueUSD < 0 ? COLORS.BRIGHT_RED : COLORS.GRAY;
  console.log(`${colorText('Expected Value (EV):', COLORS.BOLD + COLORS.WHITE)} ${colorText(formatUSDValue(stats.expectedValueUSD).replace(/\x1b\[[0-9;]*m/g, ''), evColor, true)}`);
  console.log('');
  
  // Show biggest wins and losses
  if (stats.biggestWinUSD > 0 || stats.biggestLossUSD < 0) {
    console.log(`${colorText('🎯 BEST & WORST TRADES:', COLORS.BOLD + COLORS.WHITE)}`);
    
    if (stats.biggestWinUSD > 0) {
      console.log(`${colorText('Biggest Win:', COLORS.WHITE)} ${formatUSDValue(stats.biggestWinUSD)} ${formatBigPercentage(stats.biggestWinPercent)}`);
    }
    if (stats.biggestLossUSD < 0) {
      console.log(`${colorText('Biggest Loss:', COLORS.WHITE)} ${formatUSDValue(stats.biggestLossUSD)} ${formatBigPercentage(stats.biggestLossPercent)}`);
    }
    console.log('');
  }
}

async function showSummary(positions: Record<string, Position>): Promise<void> {
  const closedPositions = Object.values(positions).filter(pos => pos.is_closed);
  
  if (closedPositions.length === 0) {
    console.log(colorText('No closed positions found for summary.', COLORS.GRAY));
    return;
  }

  // Get SOL price once for all calculations
  const solPrice = await getSOLPriceUSD();
  
  console.log(`\n${colorText('━'.repeat(60), COLORS.CYAN)}`);
  console.log(`${colorText('                    📊 TRADING SUMMARY 📊', COLORS.BOLD + COLORS.WHITE)}`);
  console.log(`${colorText('━'.repeat(60), COLORS.CYAN)}`);
  console.log('');
  
  // Show daily summaries for last 7 days
  const today = new Date();
  today.setHours(23, 59, 59, 999); // End of today
  
  console.log(`${colorText('📅 DAILY BREAKDOWN - LAST 7 DAYS', COLORS.BOLD + COLORS.WHITE)}`);
  console.log(colorText('==================================', COLORS.CYAN));
  console.log('');
  
  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(today);
    dayStart.setDate(today.getDate() - i);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(today);
    dayEnd.setDate(today.getDate() - i);
    dayEnd.setHours(23, 59, 59, 999);
    
    const dayPositions = closedPositions.filter(position => {
      if (!position.closed_at) return false;
      const closedDate = new Date(position.closed_at);
      return closedDate >= dayStart && closedDate <= dayEnd;
    });
    
    const dayName = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : dayStart.toLocaleDateString('en-US', { weekday: 'long' });
    const dateStr = dayStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    
    if (dayPositions.length > 0) {
      const stats = calculateSummaryStats(dayPositions);
      const totalInvestedSOL = solPrice > 0 ? stats.totalInvestedUSD / solPrice : 0;
      const totalPnlSOL = solPrice > 0 ? stats.totalPnlUSD / solPrice : 0;
      
      console.log(`${colorText(`${dayName} (${dateStr})`, COLORS.BRIGHT_CYAN, true)}`);
      console.log(`  ${colorText('Positions:', COLORS.WHITE)} ${colorText(dayPositions.length.toString(), COLORS.BRIGHT_YELLOW, true)} | ${colorText('Win Rate:', COLORS.WHITE)} ${colorText(`${stats.winRate.toFixed(1)}%`, stats.winRate >= 50 ? COLORS.BRIGHT_GREEN : COLORS.BRIGHT_RED, true)} | ${colorText('PNL:', COLORS.WHITE)} ${formatUSDValue(stats.totalPnlUSD)} ${formatBigPercentage(stats.overallPnlPercentage)}`);
      console.log(`  ${colorText('Invested:', COLORS.GRAY)} ${formatUSDNeutral(stats.totalInvestedUSD)} ${colorText(`(${totalInvestedSOL.toFixed(4)} SOL)`, COLORS.GRAY)}`);
      console.log('');
    } else {
      console.log(`${colorText(`${dayName} (${dateStr})`, COLORS.GRAY)}`);
      console.log(`  ${colorText('No positions closed', COLORS.GRAY)}`);
      console.log('');
    }
  }
  
  console.log(`${colorText('━'.repeat(40), COLORS.GRAY)}`);
  console.log('');
  
  // Show overall summary
  await displaySummarySection('📈 ALL TIME', closedPositions, solPrice);
  
  console.log(`${colorText('━'.repeat(60), COLORS.CYAN)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage:');
    console.log('  ./damm-pnl <token_name> <current_position_value_usd> [fees_claimed_usd]');
    console.log('  ./damm-pnl claim-fee <token_name> <fees_claimed_usd>');
    console.log('  ./damm-pnl add-capital <token_name> <additional_capital_usd>');
    console.log('  ./damm-pnl withdraw <token_name> <amount_usd>');
    console.log('  ./damm-pnl close <token_name> <exit_value_usd> [final_fees_usd]');
    console.log('  ./damm-pnl remove <token_name>');
    console.log('  ./damm-pnl reset <token_name> <new_initial_value_usd>');
    console.log('  ./damm-pnl clean');
    console.log('  ./damm-pnl list');
    console.log('  ./damm-pnl closed');
    console.log('  ./damm-pnl summary');
    console.log('');
    console.log('Examples:');
    console.log('  ./damm-pnl aixbt 249.07    # Position value in USD');
    console.log('  ./damm-pnl aixbt 275.50 12.30    # With fees claimed in USD');
    console.log('  ./damm-pnl claim-fee aixbt 12.30    # Only claim fees (no position update)');
    console.log('  ./damm-pnl add-capital aixbt 360.00    # Add $360 more capital');
    console.log('  ./damm-pnl withdraw aixbt 100.00    # Withdraw $100 from position');
    console.log('  ./damm-pnl close bb 730.00 5.00    # Close position at $730 with $5 final fees');
    console.log('  ./damm-pnl remove aixbt');
    console.log('  ./damm-pnl reset aixbt 200.00    # Reset to $200 USD');
    console.log('  ./damm-pnl clean  # Remove positions with incorrect data');
    console.log('  ./damm-pnl list    # Show active positions');
    console.log('  ./damm-pnl closed  # Show closed positions');
    console.log('  ./damm-pnl summary  # Show trading performance summary (last 7 days + all time)');
    process.exit(1);
  }

  const command = args[0].toLowerCase();
  const positions = loadPositions();

  if (command === 'list') {
    listAllPositions(positions);
    return;
  }

  if (command === 'closed') {
    await listClosedPositions(positions);
    return;
  }

  if (command === 'summary') {
    await showSummary(positions);
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


  if (command === 'remove') {
    if (args.length < 2) {
      console.error('Usage: ./damm-pnl remove <token_name>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const position = findActivePosition(positions, token);
    
    if (!position) {
      console.error(`No active position for ${token.toUpperCase()} found.`);
      process.exit(1);
    }
    
    delete positions[position.id];
    savePositions(positions);
    console.log(colorText(`✅ Active position for ${token.toUpperCase()} has been removed.`, COLORS.BRIGHT_GREEN));
    
    const closedPositions = findClosedPositions(positions, token);
    if (closedPositions.length > 0) {
      console.log(colorText(`💡 Note: You still have ${closedPositions.length} closed position(s) for ${token.toUpperCase()}.`, COLORS.GRAY));
    }
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
    
    const oldPosition = findActivePosition(positions, token);
    if (!oldPosition) {
      console.error(`No active position for ${token.toUpperCase()} found.`);
      process.exit(1);
    }
    
    // Remove old position and create new one
    delete positions[oldPosition.id];
    const newPosition = await initializePosition(token, newInitialValue);
    positions[newPosition.id] = newPosition;
    
    savePositions(positions);
    console.log(colorText(`✅ Active position for ${token.toUpperCase()} has been reset.`, COLORS.BRIGHT_GREEN));
    const oldValue = oldPosition.initial_value_usd || 0;
    console.log(`${colorText('Old initial value:', COLORS.GRAY)} ${formatUSDNeutral(oldValue)} ${colorText('->', COLORS.GRAY)} ${formatUSDNeutral(newInitialValue)}`);
    return;
  }

  if (command === 'claim-fee') {
    if (args.length < 3) {
      console.error('Usage: ./damm-pnl claim-fee <token_name> <fees_claimed_usd>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const feesToClaimUSD = parseFloat(args[2]);
    
    if (isNaN(feesToClaimUSD)) {
      console.error(`Error: Fees claimed must be a number, got '${args[2]}'`);
      process.exit(1);
    }
    
    if (feesToClaimUSD <= 0) {
      console.error(`Error: Fees claimed must be positive, got '${feesToClaimUSD}'`);
      process.exit(1);
    }
    
    const position = findActivePosition(positions, token);
    if (!position) {
      console.error(`No active position for ${token.toUpperCase()} found. Create a position first.`);
      process.exit(1);
    }
    
    // Add the fees to the position
    position.fees_claimed_usd += feesToClaimUSD;
    position.last_updated = new Date().toISOString();
    
    savePositions(positions);
    console.log(colorText(`💰 Claimed $${feesToClaimUSD.toFixed(2)} in fees for ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
    console.log(`${colorText('Total fees claimed:', COLORS.GRAY)} ${formatUSDNeutral(position.fees_claimed_usd)}`);
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
    
    const position = findActivePosition(positions, token);
    if (!position) {
      console.error(`No active position for ${token.toUpperCase()} found. Create a position first.`);
      process.exit(1);
    }
    
    // Initialize fields if they don't exist (backward compatibility)
    if (position.capital_additions_usd === undefined) {
      position.capital_additions_usd = 0;
    }
    if (position.withdrawn_usd === undefined) {
      position.withdrawn_usd = 0;
    }
    
    // Add the capital
    position.capital_additions_usd += additionalCapital;
    // Update total invested: initial + additions (withdrawals don't change this)
    position.total_invested_usd = position.initial_value_usd + position.capital_additions_usd;
    position.last_updated = new Date().toISOString();
    
    savePositions(positions);
    console.log(colorText(`💰 Added $${additionalCapital.toFixed(2)} capital to ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
    console.log(`${colorText('Total invested:', COLORS.GRAY)} ${formatUSDNeutral(position.total_invested_usd)} ${colorText('(initial:', COLORS.GRAY)} ${formatUSDNeutral(position.initial_value_usd)} ${colorText('+ additions:', COLORS.GRAY)} ${formatUSDNeutral(position.capital_additions_usd)}${colorText(')', COLORS.GRAY)}`);
    return;
  }

  if (command === 'withdraw') {
    if (args.length < 3) {
      console.error('Usage: ./damm-pnl withdraw <token_name> <amount_usd>');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const amountToTake = parseFloat(args[2]);
    
    if (isNaN(amountToTake)) {
      console.error(`Error: Amount must be a number, got '${args[2]}'`);
      process.exit(1);
    }
    
    if (amountToTake <= 0) {
      console.error(`Error: Amount must be positive, got '${amountToTake}'`);
      process.exit(1);
    }
    
    const position = findActivePosition(positions, token);
    if (!position) {
      console.error(`No active position for ${token.toUpperCase()} found.`);
      process.exit(1);
    }
    
    // Initialize fields if they don't exist (backward compatibility)
    if (position.capital_additions_usd === undefined) {
      position.capital_additions_usd = 0;
    }
    if (position.withdrawn_usd === undefined) {
      position.withdrawn_usd = 0;
    }
    
    // Total invested stays constant: initial + additions
    const totalInvested = position.initial_value_usd + position.capital_additions_usd;
    
    // Update the position - simple withdrawal
    position.withdrawn_usd += amountToTake;
    position.total_invested_usd = totalInvested;
    position.last_updated = new Date().toISOString();
    
    savePositions(positions);
    
    console.log(colorText(`💰 Withdrew $${amountToTake.toFixed(2)} from ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
    console.log(`${colorText('Total invested (unchanged):', COLORS.GRAY)} ${formatUSDNeutral(totalInvested)}`);
    console.log(`${colorText('Total withdrawn:', COLORS.GRAY)} ${formatUSDValue(position.withdrawn_usd)}`);
    return;
  }

  if (command === 'close') {
    if (args.length < 3) {
      console.error('Usage: ./damm-pnl close <token_name> <exit_value_usd> [final_fees_usd]');
      process.exit(1);
    }
    
    const token = args[1].toLowerCase();
    const exitValueUSD = parseFloat(args[2]);
    let finalFeesUSD = 0;
    
    if (args.length >= 4) {
      finalFeesUSD = parseFloat(args[3]);
      if (isNaN(finalFeesUSD)) {
        console.error(`Error: Final fees must be a number, got '${args[3]}'`);
        process.exit(1);
      }
    }
    
    if (isNaN(exitValueUSD)) {
      console.error(`Error: Exit value must be a number, got '${args[2]}'`);
      process.exit(1);
    }
    
    if (exitValueUSD <= 0) {
      console.error(`Error: Exit value must be positive, got '${exitValueUSD}'`);
      process.exit(1);
    }
    
    const position = findActivePosition(positions, token);
    if (!position) {
      console.error(`No active position for ${token.toUpperCase()} found.`);
      process.exit(1);
    }
    
    // Initialize fields if they don't exist (backward compatibility)
    if (position.capital_additions_usd === undefined) {
      position.capital_additions_usd = 0;
    }
    if (position.withdrawn_usd === undefined) {
      position.withdrawn_usd = 0;
    }
    
    // Add final fees to total fees claimed
    position.fees_claimed_usd += finalFeesUSD;
    
    // Calculate final PNL using simplified logic
    const totalInvested = position.initial_value_usd + position.capital_additions_usd; // Total capital invested
    const withdrawn = position.withdrawn_usd || 0; // Total withdrawn
    const totalValueUSD = exitValueUSD + withdrawn + position.fees_claimed_usd; // Total value received
    const finalTotalPnlUSD = totalValueUSD - totalInvested; // Total return minus total invested
    const finalPnlPercentage = totalInvested > 0 ? (finalTotalPnlUSD / totalInvested) * 100 : 0;
    
    // Mark position as closed
    const now = new Date().toISOString();
    position.closed_at = now;
    position.exit_value_usd = exitValueUSD;
    position.final_pnl_usd = finalTotalPnlUSD;
    position.final_pnl_percentage = finalPnlPercentage;
    position.total_invested_usd = totalInvested; // Store total invested amount
    position.is_closed = true;
    position.last_updated = now;
    
    savePositions(positions);
    
    // Display final position summary
    console.log(colorText(`🏁 Position ${token.toUpperCase()} CLOSED`, COLORS.BRIGHT_MAGENTA, true));
    console.log(`${colorText('Exit Value:', COLORS.WHITE)} ${formatUSDNeutral(exitValueUSD)}`);
    if (finalFeesUSD > 0) {
      console.log(`${colorText('Final Fees:', COLORS.WHITE)} ${formatUSDNeutral(finalFeesUSD)}`);
    }
    console.log(`${colorText('Total Invested:', COLORS.WHITE)} ${formatUSDNeutral(totalInvested)}`);
    console.log(`${colorText('Final PNL:', COLORS.BOLD + COLORS.WHITE)} ${formatUSDValue(finalTotalPnlUSD)} ${formatPercentage(finalPnlPercentage)}`);
    
    const daysOpen = Math.floor((new Date(now).getTime() - new Date(position.created_at).getTime()) / (1000 * 60 * 60 * 24));
    console.log(`${colorText('Position Duration:', COLORS.GRAY)} ${colorText(`${daysOpen} day${daysOpen !== 1 ? 's' : ''}`, COLORS.WHITE)}`);
    console.log(`${colorText('Closed at:', COLORS.GRAY)} ${colorText(now.substring(0, 19), COLORS.WHITE)}`);
    
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

  let position = findActivePosition(positions, token);
  
  if (!position) {
    // Check if user is trying to re-enter a token they previously had
    const closedPositions = findClosedPositions(positions, token);
    if (closedPositions.length > 0) {
      console.log(colorText(`💡 Note: You have ${closedPositions.length} closed position(s) for ${token.toUpperCase()}. Creating new position.`, COLORS.BRIGHT_YELLOW));
    }
    
    position = await initializePosition(token, currentValueUSD);
    positions[position.id] = position;
    console.log(colorText(`🚀 New position created for ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
  } else {
    position.fees_claimed_usd += feesToAddUSD;
    position.last_updated = new Date().toISOString();
    
    if (feesToAddUSD > 0) {
      console.log(colorText(`💰 Added $${feesToAddUSD.toFixed(2)} in fees to ${token.toUpperCase()}`, COLORS.BRIGHT_GREEN));
    }
  }

  savePositions(positions);
  await displayPositionInfo(token, position, currentValueUSD);
}

if (require.main === module) {
  main().catch(error => {
    console.error(colorText(`❌ Error: ${error}`, COLORS.BRIGHT_RED));
    process.exit(1);
  });
}