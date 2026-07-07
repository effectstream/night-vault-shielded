import { Buffer } from 'buffer';
import process from 'process';

// Midnight's ledger/runtime expect Node globals in the browser.
globalThis.Buffer = Buffer;
globalThis.process = process;
globalThis.global = globalThis;
if (!process.env) {
  process.env = {};
}
