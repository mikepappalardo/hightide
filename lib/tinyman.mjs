/**
 * Tinyman integration for Algorand chain — WAD ↔ ALGO two-hop swaps
 *
 * Route: WAD → USDC → ALGO  (or reverse)
 *
 * No direct WAD/ALGO pool exists on Tinyman Algorand mainnet.
 * We route through WAD/USDC then USDC/ALGO.
 *
 * Pools (Tinyman V2, Algorand mainnet):
 *   WAD/USDC:  NDQE23CVD5R2ZE3VKAZK6JEJUGYGM7A2VARYEOOWXOVA4GYAOV74PS7ALI
 *   USDC/ALGO: FPOU46NBKTWUZCNMNQNXRWNW3SMPOOK4ZJIN5WSILCWP662ANJLTXVRUKA
 */

import algosdk from 'algosdk';
import { createRequire } from 'module';
import { config } from './env.mjs';

const require = createRequire(import.meta.url);
const { poolUtils, Swap, SwapType, generateSwapRouterTxns } =
  require('../node_modules/@tinymanorg/tinyman-js-sdk');

// Asset IDs on Algorand mainnet
export const ASSETS = {
  ALGO: 0,
  USDC: 31566704,
  WAD:  3334160924,
};

const DECIMALS = {
  0:          6,  // ALGO
  31566704:   6,  // USDC
  3334160924: 6,  // WAD
};

const NETWORK  = 'mainnet';

function getAlgod() {
  return new algosdk.Algodv2(
    config.algodToken || '',
    config.algodServerAlgo || 'https://mainnet-api.algonode.cloud',
    config.algodPort || 443,
  );
}

/**
 * Get a Tinyman V2 pool with correct asset ordering.
 * Tinyman: asset1ID is the higher ASA ID, asset2ID is lower (ALGO=0 is always asset2).
 */
async function getPool(client, assetA, assetB) {
  // ALGO (0) is always asset2
  if (assetA === ASSETS.ALGO || assetB === ASSETS.ALGO) {
    const nonAlgo = assetA === ASSETS.ALGO ? assetB : assetA;
    return poolUtils.v2.getPoolInfo({ client, network: NETWORK, asset1ID: nonAlgo, asset2ID: ASSETS.ALGO });
  }
  // For non-ALGO pairs, higher ID = asset1
  const asset1 = Math.max(assetA, assetB);
  const asset2 = Math.min(assetA, assetB);
  return poolUtils.v2.getPoolInfo({ client, network: NETWORK, asset1ID: asset1, asset2ID: asset2 });
}

/**
 * Execute a single Tinyman V2 swap hop.
 * Returns { txid, outAmount }.
 */
async function swapHop({ client, pool, fromAsset, toAsset, amountBaseUnits, slippagePct, account }) {
  const slippage = slippagePct / 100;
  const signer   = account.addr.toString();

  const quote = await Swap.v2.getQuote({
    type:     SwapType.FixedInput,
    amount:   BigInt(amountBaseUnits),
    assetIn:  { id: fromAsset, decimals: DECIMALS[fromAsset] ?? 6 },
    assetOut: { id: toAsset,   decimals: DECIMALS[toAsset]   ?? 6 },
    pool, network: NETWORK, slippage,
  });

  if (!quote) throw new Error(`No quote for ${fromAsset}→${toAsset}`);

  const priceImpact = Number(
    quote.type === 'direct'
      ? (quote.data?.quote?.priceImpact ?? 0)
      : (quote.data?.price_impact ?? 0)
  ) * 100;

  if (priceImpact > 3) throw new Error(`Impact too high: ${priceImpact.toFixed(2)}%`);

  let txns;
  if (quote.type === 'router') {
    txns = await generateSwapRouterTxns({ initiatorAddr: signer, client, route: quote.data });
  } else {
    txns = await Swap.v2.generateTxns({
      client, network: NETWORK, quote, initiatorAddr: signer,
      slippage, swapType: SwapType.FixedInput,
    });
  }

  const signed = txns.map(t => t.txn.signTxn(account.sk));
  const res    = await client.sendRawTransaction(signed).do();
  const txid   = res.txid ?? res.txId;
  await algosdk.waitForConfirmation(client, txid, 6);

  // Extract output amount from quote
  const outAmount = quote.type === 'direct'
    ? BigInt(quote.data?.quote?.assetOutAmount ?? 0)
    : BigInt(quote.data?.output_amount ?? 0);

  return { txid, outAmount };
}

/**
 * Get a two-hop swap quote: WAD→USDC→ALGO or ALGO→USDC→WAD.
 */
export async function getSwapQuote({ fromAsset, toAsset, amountBaseUnits }) {
  const client = getAlgod();

  if (fromAsset === ASSETS.WAD && toAsset === ASSETS.ALGO) {
    const pool1  = await getPool(client, ASSETS.WAD, ASSETS.USDC);
    const pool2  = await getPool(client, ASSETS.USDC, ASSETS.ALGO);

    // WAD is asset1, USDC is asset2
    const wadReserves  = Number(pool1.asset1Reserves ?? 0n);
    const usdcReserves = Number(pool1.asset2Reserves ?? 0n);
    const usdcOut = Math.floor(Number(amountBaseUnits) * usdcReserves / (wadReserves + Number(amountBaseUnits)));

    // USDC is asset1, ALGO is asset2
    const usdcRes2 = Number(pool2.asset1Reserves ?? 0n);
    const algoRes  = Number(pool2.asset2Reserves ?? 0n);
    const algoOut  = Math.floor(usdcOut * algoRes / (usdcRes2 + usdcOut));

    return { amountIn: BigInt(amountBaseUnits), amountOut: BigInt(algoOut), route: 'WAD→USDC→ALGO', priceImpact: 0 };
  }

  if (fromAsset === ASSETS.ALGO && toAsset === ASSETS.WAD) {
    const pool1  = await getPool(client, ASSETS.USDC, ASSETS.ALGO);
    const pool2  = await getPool(client, ASSETS.WAD, ASSETS.USDC);

    // USDC=asset1, ALGO=asset2
    const usdcRes  = Number(pool1.asset1Reserves ?? 0n);
    const algoRes  = Number(pool1.asset2Reserves ?? 0n);
    const usdcOut  = Math.floor(Number(amountBaseUnits) * usdcRes / (algoRes + Number(amountBaseUnits)));

    // WAD=asset1, USDC=asset2
    const wadRes   = Number(pool2.asset1Reserves ?? 0n);
    const usdcRes2 = Number(pool2.asset2Reserves ?? 0n);
    const wadOut   = Math.floor(usdcOut * wadRes / (usdcRes2 + usdcOut));

    return { amountIn: BigInt(amountBaseUnits), amountOut: BigInt(wadOut), route: 'ALGO→USDC→WAD', priceImpact: 0 };
  }

  throw new Error(`Unsupported pair: ${fromAsset}→${toAsset}`);
}

/**
 * Execute a two-hop swap on Algorand via Tinyman.
 * Interface mirrors humble.mjs for drop-in use in executor.mjs.
 */
export async function executeSwap({
  fromAsset,
  toAsset,
  amountBaseUnits,
  slippagePct = 0.5,
  account,              // algosdk account (required for Algorand)
  signCallback,         // ignored — we sign directly
  chain,                // ignored — always Algorand
  walletAddress,        // ignored — derived from account
}) {
  if (!account) throw new Error('Tinyman executeSwap requires account object');

  const client = getAlgod();

  if (fromAsset === ASSETS.WAD && toAsset === ASSETS.ALGO) {
    // Hop 1: WAD → USDC
    const pool1 = await getPool(client, ASSETS.WAD, ASSETS.USDC);
    const hop1  = await swapHop({ client, pool: pool1, fromAsset: ASSETS.WAD, toAsset: ASSETS.USDC, amountBaseUnits, slippagePct, account });
    await new Promise(r => setTimeout(r, 3000));

    // Hop 2: USDC → ALGO
    const pool2 = await getPool(client, ASSETS.USDC, ASSETS.ALGO);
    const hop2  = await swapHop({ client, pool: pool2, fromAsset: ASSETS.USDC, toAsset: ASSETS.ALGO, amountBaseUnits: hop1.outAmount, slippagePct, account });

    return hop2.txid;
  }

  if (fromAsset === ASSETS.ALGO && toAsset === ASSETS.WAD) {
    // Hop 1: ALGO → USDC
    const pool1 = await getPool(client, ASSETS.USDC, ASSETS.ALGO);
    const hop1  = await swapHop({ client, pool: pool1, fromAsset: ASSETS.ALGO, toAsset: ASSETS.USDC, amountBaseUnits, slippagePct, account });
    await new Promise(r => setTimeout(r, 3000));

    // Hop 2: USDC → WAD
    const pool2 = await getPool(client, ASSETS.WAD, ASSETS.USDC);
    const hop2  = await swapHop({ client, pool: pool2, fromAsset: ASSETS.USDC, toAsset: ASSETS.WAD, amountBaseUnits: hop1.outAmount, slippagePct, account });

    return hop2.txid;
  }

  throw new Error(`Unsupported pair: ${fromAsset}→${toAsset}`);
}

export function makeAlgoSigner(account) {
  return async (txnsB64) =>
    txnsB64.map(b64 => {
      const txn = algosdk.decodeUnsignedTransaction(Buffer.from(b64, 'base64'));
      return txn.signTxn(account.sk);
    });
}
