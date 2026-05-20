/**
 * DorkFi integration — market data + transaction building
 */
import algosdk from 'algosdk';
import { config } from './env.mjs';

const API = 'https://dorkfi-api.nautilus.sh';

// Known pool IDs and market IDs
export const POOLS = {
  voi:      { primary: 47139778, wad: 47139781 },
  algorand: { primary: 3345940978, wad: 3345940978 }, // WAD pool handles ALGO looping
};

// DorkFi market app IDs (NOT ASA IDs) — identified from API
export const MARKET_IDS = {
  voi: {
    VOI:   41877720,
    aUSDC: 395614,
    UNIT:  420069,
    WAD:   47138068,
  },
  algorand: {
    ALGO:  3207744109,  // CF=0.65, LT=0.80, price~$0.112
    USDC:  3210682240,  // CF=0.70, LT=0.85, price=$1.00
    WAD:   3333688448,  // CF=0.80, LT=0.90, price=$1.00
  },
};

// Price field uses 24 fixed decimal places for all assets on both chains
const PRICE_SCALE = 1e24;

export async function getMarket(chain, symbol) {
  // Unified endpoint returns all markets across chains — filter by network + marketId
  const network = chain === 'voi' ? 'voi-mainnet' : 'algorand-mainnet';
  const marketId = MARKET_IDS[chain]?.[symbol.toUpperCase()];

  if (marketId === undefined) return null;

  const r = await fetch(`${API}/market-data?network=${network}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`DorkFi API ${r.status}`);
  const data = await r.json();
  const markets = Array.isArray(data) ? data : (data.data ?? data.markets ?? []);

  const raw = markets.find(m => Number(m.marketId) === Number(marketId) && m.network === network);
  if (!raw) return null;

  // Normalise fields so executor.mjs works consistently
  const priceUsd  = Number(raw.price ?? 0) / PRICE_SCALE;
  const cf        = Number(raw.collateralFactor  ?? 0) / 10000;
  const lt        = Number(raw.liquidationThreshold ?? 0) / 10000;
  const totalDep  = Number(raw.totalScaledDeposits ?? 0);
  const totalBor  = Number(raw.totalScaledBorrows  ?? 0);
  const depIndex  = Number(raw.depositIndex ?? 1e18) / 1e18;
  const borIndex  = Number(raw.borrowIndex  ?? 1e18) / 1e18;
  const reserveFactor = Number(raw.reserveFactor ?? 0) / 10000;
  const slope     = Number(raw.slope ?? 0) / 10000;
  const baseRate  = Number(raw.borrowRate ?? 0) / 10000;
  const utilisation = totalDep > 0 ? (totalBor * borIndex) / (totalDep * depIndex) : 0;
  const borrowApy = (baseRate + utilisation * slope) * 100;
  const supplyApy = borrowApy * utilisation * (1 - reserveFactor);

  return {
    symbol,
    marketId,
    price_usd:              priceUsd,
    collateral_factor:      cf,
    liquidation_threshold:  lt,
    supply_apy:             supplyApy,
    borrow_apy:             borrowApy,
    decimals:               symbol === 'UNIT' ? 8 : 6,
    _raw:                   raw,
  };
}

export async function getHealthFactor(address, chain) {
  try {
    const r = await fetch(`${API}/user-health/user/${address}?network=${chain}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (typeof d === 'number') return { hf: d };
    return {
      hf:         parseFloat(d?.health_factor ?? d?.hf ?? 0),
      collateral: parseFloat(d?.collateral_value ?? 0),
      debt:       parseFloat(d?.borrow_value ?? 0),
    };
  } catch { return null; }
}

export function getAlgod(chain) {
  const server = chain === 'voi' ? config.algodServerVoi : config.algodServerAlgo;
  return new algosdk.Algodv2(config.algodToken, server, config.algodPort);
}

export function getAccount() {
  if (!config.walletMnemonic) throw new Error('WALLET_MNEMONIC not set');
  return algosdk.mnemonicToSecretKey(config.walletMnemonic);
}

/**
 * Build + sign + send a DorkFi ABI method call.
 */
async function callMethod({ chain, appId, methodName, methodArgs, argTypes, returnType, extraFee = 1000 }) {
  const algod   = getAlgod(chain);
  const account = getAccount();
  const sp      = await algod.getTransactionParams().do();

  const abiMethod = new algosdk.ABIMethod({
    name: methodName,
    args: argTypes.map((type, i) => ({ type, name: `arg${i}` })),
    returns: { type: returnType },
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID:        appId,
    method:       abiMethod,
    methodArgs,
    sender:       account.addr,
    suggestedParams: { ...sp, fee: 1000 + extraFee, flatFee: true },
    signer: algosdk.makeBasicAccountTransactionSigner(account),
  });

  const result = await atc.execute(algod, 4);
  return result.txIDs[0];
}

export async function deposit({ chain, poolId, marketId, amountBaseUnits }) {
  return callMethod({
    chain, appId: poolId,
    methodName: 'deposit',
    argTypes:   ['uint64', 'uint256'],
    returnType: 'uint256',
    methodArgs: [marketId, amountBaseUnits],
    extraFee:   2000,
  });
}

export async function borrow({ chain, poolId, marketId, amountBaseUnits }) {
  return callMethod({
    chain, appId: poolId,
    methodName: 'borrow',
    argTypes:   ['uint64', 'uint256'],
    returnType: 'uint256',
    methodArgs: [marketId, amountBaseUnits],
    extraFee:   2000,
  });
}

export async function repay({ chain, poolId, marketId, amountBaseUnits }) {
  return callMethod({
    chain, appId: poolId,
    methodName: 'repay',
    argTypes:   ['uint64', 'uint256'],
    returnType: 'uint256',
    methodArgs: [marketId, amountBaseUnits],
    extraFee:   2000,
  });
}

export async function withdraw({ chain, poolId, marketId, amountBaseUnits }) {
  return callMethod({
    chain, appId: poolId,
    methodName: 'withdraw',
    argTypes:   ['uint64', 'uint256'],
    returnType: 'uint256',
    methodArgs: [marketId, amountBaseUnits],
    extraFee:   2000,
  });
}
