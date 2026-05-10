/**
 * HighTide Monitor
 *
 * Watches open loop positions and triggers partial unwind
 * if HF drops below the position's target floor.
 */

import { getActivePositions, updatePosition } from './lib/positions.mjs';
import { getHealthFactor } from './lib/dorkfi.mjs';
import { calculateUnwindSteps } from './lib/calculator.mjs';
import { sendTelegram, log } from './lib/notify.mjs';
import { config } from './lib/env.mjs';

const POLL_MS       = (parseInt(process.env.POLL_INTERVAL) || 60) * 1000;
const WARN_BUFFER   = 0.15;  // warn when HF is within 15% of target
const lastAlerts    = {};

async function checkPosition(pos) {
  const hfData = await getHealthFactor(pos.wallet, pos.chain);
  if (!hfData?.hf) return;

  const { hf } = hfData;
  const floor  = pos.target_hf;

  log(`  [${pos.id}] HF: ${hf.toFixed(4)} | Floor: ${floor} | Leverage: ${pos.effective_leverage}x`);

  // Emergency unwind — HF critically low
  if (hf < floor) {
    const cooldownKey = `${pos.id}:unwind`;
    const last = lastAlerts[cooldownKey] ?? 0;
    if (Date.now() - last < 5 * 60 * 1000) return; // 5 min cooldown

    lastAlerts[cooldownKey] = Date.now();

    log(`  [${pos.id}] HF ${hf.toFixed(4)} below floor ${floor} — triggering partial unwind`);

    await sendTelegram([
      `⚡ *HighTide — Auto-Unwind Triggered*`,
      ``,
      `Position: \`${pos.id}\``,
      `Current HF: ${hf.toFixed(4)} (floor: ${floor})`,
      `Unwinding one loop layer to restore safety...`,
    ].join('\n'));

    try {
      const { unwindLoop } = await import('./executor.mjs');
      // Partial unwind — one step only, enough to restore HF
      await unwindLoop({ positionId: pos.id, chain: pos.chain });
    } catch (err) {
      log(`  [${pos.id}] Unwind failed: ${err.message}`);
      await sendTelegram(`🚨 *HighTide — Unwind Failed*\n\nPosition: \`${pos.id}\`\nError: ${err.message}\n\n⚠️ Manual action required.`);
    }
    return;
  }

  // Early warning
  if (hf < floor * (1 + WARN_BUFFER)) {
    const warnKey = `${pos.id}:warn`;
    const last = lastAlerts[warnKey] ?? 0;
    if (Date.now() - last < 60 * 60 * 1000) return; // 1 hr cooldown on warn

    lastAlerts[warnKey] = Date.now();

    await sendTelegram([
      `⚠️ *HighTide — Position Warning*`,
      ``,
      `Position: \`${pos.id}\``,
      `HF: ${hf.toFixed(4)} approaching floor of ${floor}`,
      `Consider adding collateral or partial unwind.`,
    ].join('\n'));
  }
}

export async function startMonitor() {
  log(`HighTide monitor starting | Poll: ${POLL_MS / 1000}s`);

  async function cycle() {
    const positions = getActivePositions();
    if (!positions.length) { log('No active positions'); return; }
    log(`Monitoring ${positions.length} position(s)...`);
    for (const pos of positions) {
      try { await checkPosition(pos); }
      catch (e) { log(`  Error checking ${pos.id}: ${e.message}`); }
    }
  }

  await cycle();
  setInterval(cycle, POLL_MS);
}
