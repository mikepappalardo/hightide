/**
 * DorkFi integration — market data + transaction building
 */
import algosdk from 'algosdk';
import { config } from './env.mjs';

const API = 'https://dorkfi-api.nautilus.sh';

// Known pool IDs and market IDs
export const POOLS = {
  voi:      { primary: 47139778, wad: 47139781 },
  algorand: { primary: 3333688282, wad: 3345940978 },
};

export const MARKET_IDS = {
  voi: {
    VOI:   41877720,
    aUSDC: 395614,
    UNIT:  420069,
    WAD:   47138068,
  },
  algorand: {
    ALGO:  0,          // native
    USDC:  31566704,
    UNIT:  3121954282,
    WAD:   3334160924,
  },
};

export async function getMarket(chain, symbol) {
  const r = await fetch(`${API}/market-data/${chain}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`DorkFi API ${r.status}`);
  const data = await r.json();
  const markets = Array.isArray(data) ? data : (data.markets ?? []);
  return markets.find(m =>
    m.symbol?.toUpperCase() === symbol.toUpperCase() ||
    m.asset?.toUpperCase()  === symbol.toUpperCase()
  ) ?? null;
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
