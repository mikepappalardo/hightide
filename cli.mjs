#!/usr/bin/env node
/**
 * HighTide CLI
 *
 * Usage:
 *   node cli.mjs plan  --chain voi --asset VOI --amount 1000 --amount-usd 127 --target-hf 1.5
 *   node cli.mjs open  --chain voi --asset VOI --amount 1000 --amount-usd 127 --target-hf 1.5
 *   node cli.mjs open  --dry-run ...
 *   node cli.mjs unwind --position pos_1234567890
 *   node cli.mjs status
 *   node cli.mjs status --position pos_1234567890
 */

import './lib/env.mjs';
import { calculateLoop } from './lib/calculator.mjs';
import { getMarket }     from './lib/dorkfi.mjs';
import { openLoop, unwindLoop } from './executor.mjs';
import { getAllPositions, getPosition } from './lib/positions.mjs';

const args    = process.argv.slice(2);
const command = args[0];

function flag(name, def = null) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? (args[idx + 1] ?? true) : def;
}

async function main() {
  switch (command) {

    case 'plan': {
      const chain     = flag('chain', 'voi');
      const asset     = flag('asset', 'VOI');
      const amountUsd = parseFloat(flag('amount-usd', '100'));
      const targetHF  = parseFloat(flag('target-hf', '1.5'));
      const maxLoops  = parseInt(flag('max-loops', '8'));

      const market = await getMarket(chain, asset);
      if (!market) { console.error(`Market not found: ${asset}`); process.exit(1); }

      const borrowMarket = await getMarket(chain, 'WAD');
      const plan = calculateLoop({
        initialAmountUsd:   amountUsd,
        collateralFactor:   parseFloat(market.collateral_factor ?? market.ltv ?? 0.75),
        liquidationThreshold: parseFloat(market.liquidation_threshold ?? 0.80),
        targetHF,
        maxLoops,
        supplyRateApy: parseFloat(market.supply_apy ?? 0) / 100,
        borrowRateApy: parseFloat(borrowMarket?.borrow_apy ?? 0) / 100,
      });

      console.log('\n══ HighTide Loop Plan ══════════════════════');
      console.log(`Asset: ${asset} on ${chain}`);
      console.log(`Initial: $${plan.initial_usd} | Target HF: ${targetHF}`);
      console.log(`Loops: ${plan.loops_executed} | Leverage: ${plan.effective_leverage}x`);
      console.log(`Projected HF: ${plan.projected_hf}`);
      console.log(`Total Supplied: $${plan.total_supplied_usd}`);
      console.log(`Total Borrowed: $${plan.total_borrowed_usd}`);
      console.log(`Net APY: ${plan.net_apy_pct}%`);
      console.log('\nStep-by-step:');
      for (const s of plan.steps) {
        console.log(`  Loop ${s.loop}: supply $${s.supply_usd} → borrow $${s.borrow_usd} → HF: ${s.hf_after}`);
      }
      console.log('═══════════════════════════════════════════\n');
      break;
    }

    case 'open': {
      const chain     = flag('chain', 'voi');
      const asset     = flag('asset', 'VOI');
      const amount    = parseInt(flag('amount', '0'));
      const amountUsd = parseFloat(flag('amount-usd', '0'));
      const targetHF  = parseFloat(flag('target-hf', '1.5'));
      const dryRun    = flag('dry-run') !== null;

      if (!amount || !amountUsd) {
        console.error('--amount (base units) and --amount-usd required');
        process.exit(1);
      }

      const result = await openLoop({
        chain, supplyAsset: asset, borrowAsset: 'WAD',
        initialAmount: amount, initialAmountUsd: amountUsd,
        targetHF, dryRun,
      });

      if (dryRun) {
        console.log('\n[DRY RUN] Plan only — not executed');
        console.log(JSON.stringify(result.plan, null, 2));
      } else {
        console.log(`\nPosition opened: ${result.position.id}`);
        console.log(`Leverage: ${result.plan.effective_leverage}x | HF: ${result.plan.projected_hf}`);
      }
      break;
    }

    case 'unwind': {
      const posId  = flag('position');
      const dryRun = flag('dry-run') !== null;
      if (!posId) { console.error('--position required'); process.exit(1); }
      await unwindLoop({ positionId: posId, chain: getPosition(posId)?.chain ?? 'voi', dryRun });
      break;
    }

    case 'status': {
      const posId = flag('position');
      if (posId) {
        const pos = getPosition(posId);
        if (!pos) { console.error('Position not found'); process.exit(1); }
        console.log(JSON.stringify(pos, null, 2));
      } else {
        const all = getAllPositions();
        if (!all.length) { console.log('No positions'); break; }
        console.log(`\n${'ID'.padEnd(20)} ${'Status'.padEnd(8)} ${'Asset'.padEnd(6)} ${'Leverage'.padEnd(10)} ${'HF'.padEnd(8)} Created`);
        console.log('─'.repeat(70));
        for (const p of all) {
          console.log(
            `${p.id.padEnd(20)} ${p.status.padEnd(8)} ${p.supply_asset.padEnd(6)} ${String(p.effective_leverage + 'x').padEnd(10)} ${String(p.projected_hf).padEnd(8)} ${p.created_at.slice(0,10)}`
          );
        }
      }
      break;
    }

    default:
      console.log(`
HighTide — DorkFi Loop Automation

Commands:
  plan    Preview a loop without executing
  open    Open a leveraged loop position
  unwind  Close/unwind a position
  status  View open positions

Options:
  --chain      voi | algorand (default: voi)
  --asset      Supply asset symbol (default: VOI)
  --amount     Initial amount in base units
  --amount-usd Initial amount in USD
  --target-hf  Target health factor (default: 1.5)
  --max-loops  Max loop iterations (default: 8)
  --position   Position ID (for unwind/status)
  --dry-run    Preview without executing

Examples:
  node cli.mjs plan --chain voi --asset VOI --amount-usd 127 --target-hf 1.5
  node cli.mjs open --chain voi --asset VOI --amount 1000000000 --amount-usd 127 --dry-run
  node cli.mjs status
  node cli.mjs unwind --position pos_1234567890
      `);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
