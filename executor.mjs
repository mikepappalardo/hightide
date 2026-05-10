/**
 * HighTide Executor
 *
 * Opens and unwinds leveraged loop positions on DorkFi.
 *
 * Open flow:  supply → borrow WAD → swap WAD→asset → supply → repeat
 * Unwind flow: withdraw collateral → repay WAD → repeat
 */

import algosdk from 'algosdk';
import { calculateLoop, calculateUnwindSteps } from './lib/calculator.mjs';
import { getMarket, getAccount, getAlgod, deposit, borrow, repay, withdraw, POOLS, MARKET_IDS } from './lib/dorkfi.mjs';
import { getSwapQuote, executeSwap, makeAlgoSigner } from './lib/humble.mjs';
import { createPosition, updatePosition } from './lib/positions.mjs';
import { sendTelegram, log } from './lib/notify.mjs';
import { config } from './lib/env.mjs';

const STEP_DELAY_MS = 3000; // wait between steps for indexer

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Open a new leveraged loop position.
 */
export async function openLoop({
  chain         = 'voi',
  supplyAsset   = 'VOI',
  borrowAsset   = 'WAD',
  initialAmount,           // in base units of supplyAsset
  initialAmountUsd,        // USD value of initial amount
  targetHF      = config.defaultTargetHF,
  maxLoops      = config.defaultMaxLoops,
  slippagePct   = config.defaultSlippage,
  dryRun        = false,
}) {
  log(`HighTide: Opening loop | ${supplyAsset}→${borrowAsset} | Chain: ${chain} | Target HF: ${targetHF}`);

  // Fetch market params
  const supplyMarket = await getMarket(chain, supplyAsset);
  const borrowMarket = await getMarket(chain, borrowAsset);

  if (!supplyMarket) throw new Error(`Market not found: ${supplyAsset} on ${chain}`);
  if (!borrowMarket) throw new Error(`Market not found: ${borrowAsset} on ${chain}`);

  const collateralFactor    = parseFloat(supplyMarket.collateral_factor ?? supplyMarket.ltv ?? 0.75);
  const liquidationThreshold = parseFloat(supplyMarket.liquidation_threshold ?? 0.80);
  const supplyRateApy       = parseFloat(supplyMarket.supply_apy ?? supplyMarket.supplyApy ?? 0) / 100;
  const borrowRateApy       = parseFloat(borrowMarket.borrow_apy ?? borrowMarket.borrowApy ?? 0) / 100;

  log(`  Collateral factor: ${(collateralFactor * 100).toFixed(1)}% | Liq threshold: ${(liquidationThreshold * 100).toFixed(1)}%`);
  log(`  Supply APY: ${(supplyRateApy * 100).toFixed(2)}% | Borrow APY: ${(borrowRateApy * 100).toFixed(2)}%`);

  // Calculate loop plan
  const plan = calculateLoop({
    initialAmountUsd,
    collateralFactor,
    liquidationThreshold,
    targetHF,
    maxLoops,
    swapSlippagePct: slippagePct,
    supplyRateApy,
    borrowRateApy,
  });

  log(`  Loop plan: ${plan.loops_executed} loops | ${plan.effective_leverage}x leverage | Projected HF: ${plan.projected_hf}`);
  log(`  Total supply: $${plan.total_supplied_usd} | Total borrow: $${plan.total_borrowed_usd}`);
  log(`  Net APY: ${plan.net_apy_pct}%`);

  if (!plan.viable) {
    throw new Error(`Loop not viable at target HF ${targetHF} — check collateral factor and market params`);
  }

  if (dryRun) {
    log('  [DRY RUN] — not executing');
    return { plan, dryRun: true };
  }

  // Execute loop steps
  const account   = getAccount();
  const signer    = makeAlgoSigner(account);
  const poolId    = POOLS[chain].primary;
  const supplyMId = MARKET_IDS[chain][supplyAsset];
  const borrowMId = MARKET_IDS[chain][borrowAsset];
  const supplyDecimals = supplyMarket.decimals ?? 6;
  const borrowDecimals = borrowMarket.decimals ?? 6;
  const txids = [];

  // Get supply asset price for base unit conversion
  const supplyPriceUsd = parseFloat(supplyMarket.price_usd ?? supplyMarket.price ?? 1);
  const borrowPriceUsd = parseFloat(borrowMarket.price_usd ?? borrowMarket.price ?? 1);

  let currentAmountBaseUnits = BigInt(initialAmount);

  for (const step of plan.steps) {
    log(`  Loop ${step.loop}: supply $${step.supply_usd} → borrow $${step.borrow_usd} → swap → repeat`);

    // 1. Supply
    log(`    [${step.loop}] Supplying ${currentAmountBaseUnits} base units of ${supplyAsset}...`);
    const supplyTxid = await deposit({ chain, poolId, marketId: supplyMId, amountBaseUnits: currentAmountBaseUnits });
    txids.push({ loop: step.loop, action: 'supply', txid: supplyTxid });
    log(`    [${step.loop}] Supply tx: ${supplyTxid}`);
    await sleep(STEP_DELAY_MS);

    // 2. Borrow WAD
    const borrowBaseUnits = BigInt(Math.floor(step.borrow_usd / borrowPriceUsd * 10 ** borrowDecimals));
    log(`    [${step.loop}] Borrowing ${borrowBaseUnits} base units of ${borrowAsset}...`);
    const borrowTxid = await borrow({ chain, poolId, marketId: borrowMId, amountBaseUnits: borrowBaseUnits });
    txids.push({ loop: step.loop, action: 'borrow', txid: borrowTxid });
    log(`    [${step.loop}] Borrow tx: ${borrowTxid}`);
    await sleep(STEP_DELAY_MS);

    // 3. Swap WAD → supply asset (skip on last loop)
    if (step.loop < plan.steps.length) {
      log(`    [${step.loop}] Swapping ${borrowAsset} → ${supplyAsset}...`);
      const swapTxid = await executeSwap({
        fromAsset:      borrowMId,
        toAsset:        supplyMId,
        amountBaseUnits: borrowBaseUnits,
        slippagePct,
        chain,
        walletAddress: account.addr,
        signCallback:  signer,
      });
      txids.push({ loop: step.loop, action: 'swap', txid: swapTxid });
      log(`    [${step.loop}] Swap tx: ${swapTxid}`);

      // Next loop input = swap output
      const swapOut = BigInt(Math.floor(
        Number(borrowBaseUnits) * (1 - slippagePct / 100) * (borrowPriceUsd / supplyPriceUsd)
        * 10 ** supplyDecimals / 10 ** borrowDecimals
      ));
      currentAmountBaseUnits = swapOut;
      await sleep(STEP_DELAY_MS);
    }
  }

  // Create position record
  const position = createPosition({
    wallet:         account.addr,
    chain,
    supplyAsset,
    borrowAsset,
    initialUsd:     plan.initial_usd,
    totalSupplied:  plan.total_supplied_usd,
    totalBorrowed:  plan.total_borrowed_usd,
    loopsExecuted:  plan.loops_executed,
    leverage:       plan.effective_leverage,
    targetHF:       plan.target_hf,
    projectedHF:    plan.projected_hf,
    loopPlan:       plan,
    txids,
  });

  log(`  Position opened: ${position.id} | ${plan.effective_leverage}x leverage | HF: ${plan.projected_hf}`);

  await sendTelegram([
    `🌊 *HighTide — Loop Opened*`,
    ``,
    `Position: \`${position.id}\``,
    `Strategy: ${supplyAsset} → ${borrowAsset} → ${supplyAsset}`,
    `Chain: ${chain} | Loops: ${plan.loops_executed}`,
    `Leverage: ${plan.effective_leverage}x | HF: ${plan.projected_hf}`,
    `Supplied: $${plan.total_supplied_usd} | Borrowed: $${plan.total_borrowed_usd}`,
    `Net APY: ${plan.net_apy_pct}%`,
  ].join('\n'));

  return { position, plan, txids };
}

/**
 * Unwind a loop position — repay debt and withdraw collateral step by step.
 */
export async function unwindLoop({ positionId, chain, dryRun = false }) {
  const { getPosition, updatePosition } = await import('./lib/positions.mjs');
  const pos = getPosition(positionId);
  if (!pos) throw new Error(`Position ${positionId} not found`);

  log(`HighTide: Unwinding ${positionId} | ${pos.supply_asset}→${pos.borrow_asset} | Chain: ${pos.chain}`);

  const supplyMarket = await getMarket(chain, pos.supply_asset);
  const liquidationThreshold = parseFloat(supplyMarket?.liquidation_threshold ?? 0.80);
  const collateralFactor     = parseFloat(supplyMarket?.collateral_factor ?? 0.75);

  const unwindSteps = calculateUnwindSteps({
    totalSuppliedUsd:    pos.total_supplied,
    totalBorrowedUsd:    pos.total_borrowed,
    liquidationThreshold,
    targetHF:            1.0, // unwind to fully closed
    collateralFactor,
    swapSlippagePct:     config.defaultSlippage,
  });

  log(`  Unwind plan: ${unwindSteps.length} steps`);

  if (dryRun) {
    log('  [DRY RUN] — not executing');
    return { unwindSteps, dryRun: true };
  }

  const account  = getAccount();
  const poolId   = POOLS[chain].primary;
  const supplyMId = MARKET_IDS[chain][pos.supply_asset];
  const borrowMId = MARKET_IDS[chain][pos.borrow_asset];
  const signer   = makeAlgoSigner(account);
  const txids    = [];

  const supplyMarketData = await getMarket(chain, pos.supply_asset);
  const borrowMarketData = await getMarket(chain, pos.borrow_asset);
  const supplyPriceUsd   = parseFloat(supplyMarketData?.price_usd ?? 1);
  const borrowPriceUsd   = parseFloat(borrowMarketData?.price_usd ?? 1);
  const supplyDecimals   = supplyMarketData?.decimals ?? 6;
  const borrowDecimals   = borrowMarketData?.decimals ?? 6;

  for (let i = 0; i < unwindSteps.length; i++) {
    const step = unwindSteps[i];
    log(`  Unwind step ${i + 1}: withdraw $${step.withdraw_usd} | repay $${step.repay_usd}`);

    // 1. Swap supply asset → WAD (to get repay funds)
    const swapInBase = BigInt(Math.floor(step.withdraw_usd / supplyPriceUsd * 10 ** supplyDecimals));
    const swapTxid = await executeSwap({
      fromAsset:      supplyMId,
      toAsset:        borrowMId,
      amountBaseUnits: swapInBase,
      slippagePct:    config.defaultSlippage,
      chain,
      walletAddress:  account.addr,
      signCallback:   signer,
    });
    txids.push({ step: i + 1, action: 'swap', txid: swapTxid });
    await sleep(STEP_DELAY_MS);

    // 2. Repay WAD
    const repayBase = BigInt(Math.floor(step.repay_usd / borrowPriceUsd * 10 ** borrowDecimals));
    const repayTxid = await repay({ chain, poolId, marketId: borrowMId, amountBaseUnits: repayBase });
    txids.push({ step: i + 1, action: 'repay', txid: repayTxid });
    await sleep(STEP_DELAY_MS);

    // 3. Withdraw freed collateral
    const withdrawBase = BigInt(Math.floor(step.withdraw_usd / supplyPriceUsd * 10 ** supplyDecimals));
    const withdrawTxid = await withdraw({ chain, poolId, marketId: supplyMId, amountBaseUnits: withdrawBase });
    txids.push({ step: i + 1, action: 'withdraw', txid: withdrawTxid });
    await sleep(STEP_DELAY_MS);
  }

  updatePosition(positionId, { status: 'closed', unwind_txids: txids });

  log(`  Position ${positionId} closed`);
  await sendTelegram(`🌊 *HighTide — Position Closed*\n\nID: \`${positionId}\`\nUnwind steps: ${unwindSteps.length}`);

  return { txids };
}
