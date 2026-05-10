# HighTide

**Automated DorkFi looping and leverage service.**

HighTide calculates the optimal loop depth for a supply→borrow→swap leverage strategy on DorkFi, executes all steps automatically, and monitors the position's health factor — unwinding a layer if things get close.

## The Loop

```
Supply ALGO to DorkFi
       ↓
Borrow WAD against it
       ↓
Swap WAD → ALGO on HumbleSwap
       ↓
Supply that ALGO back to DorkFi
       ↓
Repeat until target health factor is reached
```

Each iteration increases your effective exposure to the supply asset without adding more capital. At 75% LTV and a 1.5 target HF, HighTide runs ~3–4 loops for approximately 2.5x effective leverage.

## Modes

| Mode | Command | Description |
|------|---------|-------------|
| Plan | `node cli.mjs plan` | Preview loop depth, leverage, APY without executing |
| Open | `node cli.mjs open` | Execute the full loop strategy |
| Monitor | `node index.mjs` | Watch open positions, auto-unwind if HF drops |
| Unwind | `node cli.mjs unwind` | Close a position gracefully |
| Status | `node cli.mjs status` | View all positions |

## Quick Start

### 1. Install

```bash
git clone https://github.com/mikepappalardo/hightide
cd hightide
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Set `WALLET_MNEMONIC`, `WALLET_ADDRESS`, and optionally Telegram credentials.

### 3. Preview a loop

```bash
node cli.mjs plan --chain voi --asset VOI --amount-usd 127 --target-hf 1.5
```

Output:
```
══ HighTide Loop Plan ══════════════════════
Asset: VOI on voi
Initial: $127.00 | Target HF: 1.5
Loops: 3 | Leverage: 2.48x
Projected HF: 1.51
Total Supplied: $314.96
Total Borrowed: $167.35
Net APY: 4.2%

Step-by-step:
  Loop 1: supply $127.00 → borrow $95.25 → HF: 2.13
  Loop 2: supply $94.78 → borrow $71.08 → HF: 1.71
  Loop 3: supply $70.69 → borrow $0.02  → HF: 1.51
═══════════════════════════════════════════
```

### 4. Open a position

```bash
# Dry run first — always
node cli.mjs open --chain voi --asset VOI --amount 1000000000 --amount-usd 127 --target-hf 1.5 --dry-run

# Live execution
node cli.mjs open --chain voi --asset VOI --amount 1000000000 --amount-usd 127 --target-hf 1.5
```

`--amount` is in base units (microVOI = 6 decimals, so 1000000000 = 1000 VOI).

### 5. Monitor positions

```bash
node index.mjs
```

Monitors all open positions. If HF drops below target floor, triggers automatic partial unwind and sends Telegram alert.

### 6. Close a position

```bash
node cli.mjs unwind --position pos_1234567890
```

Gracefully unwinds all loop layers — swaps supply asset → WAD, repays debt, withdraws collateral. Repeat until flat.

---

## Health Factor Guide

| Target HF | Leverage (75% LTV) | Risk level |
|-----------|-------------------|------------|
| 2.0 | ~1.5x | Conservative |
| 1.5 | ~2.5x | Moderate |
| 1.3 | ~3.5x | Aggressive |
| 1.1 | ~6x | Very aggressive |

Higher leverage = higher risk of liquidation during price drops. HighTide monitors and unwinds, but rapid moves can outpace any monitor.

---

## Architecture

```
cli.mjs          Command-line interface
index.mjs        Monitor daemon entry point
executor.mjs     Loop open + unwind execution
monitor.mjs      HF monitoring + auto-unwind trigger
lib/
  calculator.mjs Loop math — depth, leverage, APY projection
  dorkfi.mjs     DorkFi API + ABI transaction builder
  humble.mjs     HumbleSwap swap quotes + execution
  positions.mjs  Position registry (positions.json)
  env.mjs        Config from .env
  notify.mjs     Telegram + logging
```

---

## Risk Disclosure

Leveraged looping amplifies both gains and losses.

- A 20% drop in the supply asset at 3x leverage = ~60% drawdown on initial capital
- Liquidation risk increases with leverage
- Swap slippage compounds across loop iterations
- Oracle lag on DorkFi can hide risk during fast moves

**Start with a dry run. Use conservative target HF (≥ 1.5). Never loop more than you can afford to lose.**

---

## License

MIT
