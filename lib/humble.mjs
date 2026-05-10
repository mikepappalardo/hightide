/**
 * HumbleSwap integration — WAD ↔ supply asset swaps
 *
 * Used mid-loop to swap borrowed WAD back into the supply asset.
 */

const HUMBLE_API = 'https://api.humble.sh';

// Known pool addresses for WAD pairs on Voi
const WAD_POOLS = {
  voi: {
    'WAD/VOI':   null,  // populated from API
    'WAD/aUSDC': null,
  },
};

/**
 * Get a swap quote from HumbleSwap.
 * Returns expected output amount and price impact.
 */
export async function getSwapQuote({ fromAsset, toAsset, amountBaseUnits, chain = 'voi' }) {
  try {
    const url = `${HUMBLE_API}/v2/quote?` + new URLSearchParams({
      from:    fromAsset,
      to:      toAsset,
      amount:  amountBaseUnits.toString(),
      network: chain,
    });

    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HumbleSwap API ${r.status}`);
    const data = await r.json();

    return {
      amountIn:      BigInt(data.amountIn ?? amountBaseUnits),
      amountOut:     BigInt(data.amountOut ?? 0),
      priceImpact:   parseFloat(data.priceImpact ?? 0),
      route:         data.route ?? null,
      minAmountOut:  BigInt(data.minAmountOut ?? 0),
    };
  } catch (e) {
    throw new Error(`HumbleSwap quote failed: ${e.message}`);
  }
}

/**
 * Execute a swap via HumbleSwap.
 * Returns txid.
 */
export async function executeSwap({
  fromAsset,
  toAsset,
  amountBaseUnits,
  slippagePct = 0.5,
  chain = 'voi',
  walletAddress,
  signCallback,   // async (txns) => signedTxns
}) {
  // Get quote first
  const quote = await getSwapQuote({ fromAsset, toAsset, amountBaseUnits, chain });

  const minOut = BigInt(
    Math.floor(Number(quote.amountOut) * (1 - slippagePct / 100))
  );

  // Build swap transaction group
  const buildUrl = `${HUMBLE_API}/v2/swap`;
  const r = await fetch(buildUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:         fromAsset,
      to:           toAsset,
      amount:       amountBaseUnits.toString(),
      minAmountOut: minOut.toString(),
      sender:       walletAddress,
      network:      chain,
      slippage:     slippagePct,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!r.ok) throw new Error(`HumbleSwap build failed: ${r.status}`);
  const { transactions } = await r.json();

  const signed = await signCallback(transactions);

  // Broadcast via Algorand node
  const algosdk = (await import('algosdk')).default;
  const { config } = await import('./env.mjs');
  const server = chain === 'voi' ? config.algodServerVoi : config.algodServerAlgo;
  const algod  = new algosdk.Algodv2(config.algodToken, server, config.algodPort);

  const result = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, result.txid, 4);

  return result.txid;
}

/**
 * Simple signer callback using algosdk basic account.
 */
export function makeAlgoSigner(account) {
  return async (txnsB64) => {
    const algosdk = (await import('algosdk')).default;
    return txnsB64.map(b64 => {
      const txn = algosdk.decodeUnsignedTransaction(Buffer.from(b64, 'base64'));
      return txn.signTxn(account.sk);
    });
  };
}
