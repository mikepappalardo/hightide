/**
 * HighTide — Entry Point
 * Starts the position monitor for active loop positions.
 * Use cli.mjs to open and manage positions.
 */
import './lib/env.mjs';
import { startMonitor } from './monitor.mjs';
import { log } from './lib/notify.mjs';

log('═══════════════════════════════════════════');
log('  HighTide — DorkFi Loop Automation');
log('  Leverage. Monitor. Ride the tide.');
log('═══════════════════════════════════════════');

startMonitor();
