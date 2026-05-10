/**
 * HighTide Loop Calculator
 *
 * Computes optimal loop depth, per-step amounts, and projected
 * health factor for a DorkFi supply→borrow→swap leverage loop.
 *
 * The loop:
 *   1. Supply `supplyAsset` to DorkFi
 *   2. Borrow `borrowAsset` (WAD) against it
 *   3. Swap WAD → `supplyAsset` on HumbleSwap
 *   4. Repeat until target HF would be breached
 */

/**
 * Calculate loop plan.
 *
 * @param {object} params
 * @param {number} params.initialAmountUsd   - Starting capital in USD
 * @param {number} params.collateralFactor   - LTV (e.g. 0.75 for 75%)
 * @param {number} params.liquidationThreshold - Liquidation threshold (e.g. 0.80)
 * @param {number} params.targetHF           - Desired health factor (e.g. 1.5)
 * @param {number} params.maxLoops           - Safety cap on iterations
 * @param {number} params.swapSlippagePct    - Expected swap slippage per loop (e.g. 0.5)
 * @param {number} params.borrowRateApy      - Annual borrow rate (e.g. 0.08 for 8%)
 * @param {number} params.supplyRateApy      - Annual supply rate (e.g. 0.04 for 4%)
 *
 * @returns {object} Loop plan with steps, totals, projected HF, net APY
 */
export function calculateLoop({
  initialAmountUsd,
  collateralFactor,
  liquidationThreshold,
  targetHF,
  maxLoops = 8,
  swapSlippagePct = 0.5,
  borrowRateApy = 0,
  supplyRateApy = 0,
}) {
  const slippageFactor = 1 - swapSlippagePct / 100;
  const steps = [];

  let totalSuppliedUsd = 0;
  let totalBorrowedUsd = 0;
  let currentSupplyUsd = initialAmountUsd;

  for (let i = 0; i < maxLoops; i++) {
    // Supply this round's capital
    totalSuppliedUsd += currentSupplyUsd;

    // How much can we borrow against total collateral at targetHF?
    // HF = (totalSupplied × liquidationThreshold) / totalBorrowed
    // So maxBorrow = (totalSupplied × liquidationThreshold) / targetHF
    const maxTotalBorrow = (totalSuppliedUsd * liquidationThreshold) / targetHF;
    const remainingBorrowRoom = maxTotalBorrow - totalBorrowedUsd;

    if (remainingBorrowRoom < 0.01) break; // no room left

    // Borrow up to collateralFactor of this round's supply,
    // but capped by remaining room to maintain targetHF
    const idealBorrow = currentSupplyUsd * collateralFactor;
    const borrowThisRound = Math.min(idealBorrow, remainingBorrowRoom);

    if (borrowThisRound < 0.01) break;

    totalBorrowedUsd += borrowThisRound;

    // Swap WAD → supply asset (apply slippage)
    const swappedUsd = borrowThisRound * slippageFactor;

    steps.push({
      loop:              i + 1,
      supply_usd:        round2(currentSupplyUsd),
      borrow_usd:        round2(borrowThisRound),
      swap_out_usd:      round2(swappedUsd),
      total_supplied:    round2(totalSuppliedUsd),
      total_borrowed:    round2(totalBorrowedUsd),
      hf_after:          round4((totalSuppliedUsd * liquidationThreshold) / totalBorrowedUsd),
    });

    currentSupplyUsd = swappedUsd;
  }

  const finalHF = totalBorrowedUsd > 0
    ? (totalSuppliedUsd * liquidationThreshold) / totalBorrowedUsd
    : Infinity;

  const leverage = totalSuppliedUsd / initialAmountUsd;

  // Net APY estimate:
  // Earn supplyRateApy on totalSupplied, pay borrowRateApy on totalBorrowed
  const grossSupplyEarnings = totalSuppliedUsd * supplyRateApy;
  const borrowCost          = totalBorrowedUsd * borrowRateApy;
  const netEarningsUsd      = grossSupplyEarnings - borrowCost;
  const netApyOnInitial     = netEarningsUsd / initialAmountUsd;

  return {
    viable: steps.length > 0 && finalHF >= targetHF,
    loops_executed:    steps.length,
    initial_usd:       round2(initialAmountUsd),
    total_supplied_usd: round2(totalSuppliedUsd),
    total_borrowed_usd: round2(totalBorrowedUsd),
    effective_leverage: round2(leverage),
    projected_hf:       round4(finalHF),
    target_hf:          targetHF,
    net_apy_pct:        round2(netApyOnInitial * 100),
    gross_supply_apy_pct: round2(supplyRateApy * 100),
    borrow_apy_pct:     round2(borrowRateApy * 100),
    slippage_pct:       swapSlippagePct,
    steps,
  };
}

/**
 * Calculate how many loops to unwind to restore a target HF.
 * Used by the monitor when HF drops during position lifecycle.
 */
export function calculateUnwindSteps({
  totalSuppliedUsd,
  totalBorrowedUsd,
  liquidationThreshold,
  targetHF,
  collateralFactor,
  swapSlippagePct = 0.5,
}) {
  const steps = [];
  let supplied = totalSuppliedUsd;
  let borrowed = totalBorrowedUsd;
  const slippageFactor = 1 - swapSlippagePct / 100;

  while (borrowed > 0.01) {
    const currentHF = (supplied * liquidationThreshold) / borrowed;
    if (currentHF >= targetHF) break;

    // Withdraw one loop's worth: withdraw enough collateral to repay one borrow layer
    const repayUsd = borrowed * (1 - collateralFactor);
    const withdrawUsd = repayUsd / slippageFactor; // need more to cover slippage

    if (withdrawUsd > supplied) break; // can't withdraw more than supplied

    supplied -= withdrawUsd;
    borrowed -= repayUsd;

    steps.push({
      repay_usd:    round2(repayUsd),
      withdraw_usd: round2(withdrawUsd),
      hf_after:     round4(borrowed > 0 ? (supplied * liquidationThreshold) / borrowed : Infinity),
    });
  }

  return steps;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
