import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
}

export const config = {
  walletMnemonic:   process.env.WALLET_MNEMONIC || '',
  walletAddress:    process.env.WALLET_ADDRESS || '',
  telegramToken:    process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId:   process.env.TELEGRAM_CHAT_ID || '',
  algodToken:       process.env.ALGOD_TOKEN || '',
  algodServerVoi:   process.env.ALGOD_SERVER_VOI || 'https://mainnet-api.voi.nodely.dev',
  algodServerAlgo:  process.env.ALGOD_SERVER_ALGO || 'https://mainnet-api.algonode.cloud',
  algodPort:        parseInt(process.env.ALGOD_PORT || '443'),
  defaultTargetHF:  parseFloat(process.env.DEFAULT_TARGET_HF || '1.5'),
  defaultMaxLoops:  parseInt(process.env.DEFAULT_MAX_LOOPS || '8'),
  defaultSlippage:  parseFloat(process.env.DEFAULT_SLIPPAGE_PCT || '0.5'),
};
