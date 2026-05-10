/**
 * Position registry — tracks open HighTide loop positions.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH = join(__dirname, '..', 'positions.json');

export function loadPositions() {
  if (!existsSync(PATH)) return { positions: [] };
  return JSON.parse(readFileSync(PATH, 'utf8'));
}

export function savePositions(data) {
  writeFileSync(PATH, JSON.stringify(data, null, 2));
}

export function getPosition(id) {
  return loadPositions().positions.find(p => p.id === id) ?? null;
}

export function getAllPositions() {
  return loadPositions().positions;
}

export function getActivePositions() {
  return loadPositions().positions.filter(p => p.status === 'open');
}

export function createPosition(params) {
  const data = loadPositions();
  const id   = `pos_${Date.now()}`;
  const pos  = {
    id,
    status:         'open',
    created_at:     new Date().toISOString(),
    updated_at:     new Date().toISOString(),
    wallet:         params.wallet,
    chain:          params.chain,
    supply_asset:   params.supplyAsset,
    borrow_asset:   params.borrowAsset,
    initial_usd:    params.initialUsd,
    total_supplied: params.totalSupplied,
    total_borrowed: params.totalBorrowed,
    loops_executed: params.loopsExecuted,
    effective_leverage: params.leverage,
    target_hf:      params.targetHF,
    projected_hf:   params.projectedHF,
    loop_plan:      params.loopPlan,
    txids:          params.txids || [],
    unwind_txids:   [],
    pnl_usd:        null,
  };
  data.positions.push(pos);
  savePositions(data);
  return pos;
}

export function updatePosition(id, updates) {
  const data = loadPositions();
  const idx  = data.positions.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Position ${id} not found`);
  data.positions[idx] = {
    ...data.positions[idx],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  savePositions(data);
  return data.positions[idx];
}
