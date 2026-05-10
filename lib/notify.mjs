import { config } from './env.mjs';

export async function sendTelegram(msg) {
  const { telegramToken: token, telegramChatId: chatId } = config;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
