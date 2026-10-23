#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config as loadEnv } from 'dotenv';
import { Connection, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildSolTransfer,
  buildUsdcTransfer,
  DEFAULT_RESERVE_LAMPORTS,
  formatUnits,
  GENESIS_HASHES,
  loadKeypair,
  parseDestination,
  parseReserveSol,
  USDC_MINTS,
  usdcAccounts,
} from './core.mjs';
import { PublicKey } from '@solana/web3.js';

loadEnv({ path: fileURLToPath(new URL('../.env.local', import.meta.url)), quiet: true });

const HELP = `Solana SOL + Circle USDC wallet forwarder

Usage: npm start -- [options]

Options:
  --network mainnet|devnet  Solana network (default: mainnet)
  --rpc URL                 HTTP RPC endpoint (or SOLANA_RPC_URL)
  --ws URL                  WebSocket endpoint (or SOLANA_WS_URL)
  --keypair-file PATH       Local Solana CLI JSON keypair file, or a file with a base58 private key
  --reserve-sol AMOUNT      SOL to keep for future USDC fees (default: 0.005)
  --dry-run                 Print current transfers without signing or sending, then exit
  --help                    Show this help

Without --keypair-file, the private key is read from a hidden terminal prompt.
The destination address is always entered and confirmed at startup.
Set HELIUS_API_KEY in .env.local to use Helius automatically.`;

function errorMessage(error) {
  let message = String(error?.message || error);
  for (const key of [process.env.HELIUS_API_KEY, process.env.SOLANA_RPC_URL, process.env.SOLANA_WS_URL]) {
    if (key) message = message.replaceAll(key, '[REDACTED]');
  }
  return message.replace(/([?&]api-key=)[^&\s]+/gi, '$1[REDACTED]');
}

function optionsFromArgs(args) {
  const options = { network: 'mainnet', dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { options.help = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (!['--network', '--rpc', '--ws', '--keypair-file', '--reserve-sol'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = args[++i];
    if (!value) throw new Error(`${arg} needs a value.`);
    options[{
      '--network': 'network', '--rpc': 'rpc', '--ws': 'ws',
      '--keypair-file': 'keypairFile', '--reserve-sol': 'reserveSol',
    }[arg]] = value;
  }
  if (!['mainnet', 'devnet'].includes(options.network)) throw new Error('Network must be mainnet or devnet.');
  return options;
}

function validateEndpoint(raw, websocket) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid RPC endpoint URL.'); }
  const secure = websocket ? 'wss:' : 'https:';
  const local = websocket ? 'ws:' : 'http:';
  if (url.protocol !== secure && !(url.protocol === local && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`RPC endpoint must use ${secure} (local ${local} is allowed).`);
  }
  return url.toString();
}

function webSocketEndpoint(httpUrl) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function readHiddenLine(prompt) {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error('Hidden private-key entry needs an interactive terminal. Use --keypair-file.');
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    let value = '';
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u0003') { finish(new Error('Cancelled.')); return; }
        if (char === '\b' || char === '\u007f') { value = value.slice(0, -1); continue; }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey && !/^[A-Za-z0-9_-]+$/.test(heliusKey)) throw new Error('HELIUS_API_KEY has invalid characters.');
  const defaults = options.network === 'mainnet'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com';
  const heliusHttp = heliusKey ? `https://${options.network}.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}` : undefined;
  const http = validateEndpoint(options.rpc || process.env.SOLANA_RPC_URL || heliusHttp || defaults, false);
  const ws = validateEndpoint(options.ws || process.env.SOLANA_WS_URL || webSocketEndpoint(http), true);
  const reserve = options.reserveSol === undefined ? DEFAULT_RESERVE_LAMPORTS : parseReserveSol(options.reserveSol);
  const signer = await loadKeypair(options.keypairFile, () => readHiddenLine('Source wallet private key (hidden): '));
  const source = signer.publicKey;
  console.log(`Source wallet: ${source.toBase58()}`);
  const rl = createInterface({ input: stdin, output: stdout });
  let destination;
  try {
    destination = parseDestination(await rl.question('Destination wallet address: '), source);
    const repeated = (await rl.question('Enter the destination address again to confirm: ')).trim();
    if (repeated !== destination.toBase58()) throw new Error('Destination addresses did not match.');
  } finally {
    rl.close();
  }

  const mint = new PublicKey(USDC_MINTS[options.network]);
  const connection = new Connection(http, { commitment: 'confirmed', wsEndpoint: ws });
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== GENESIS_HASHES[options.network]) throw new Error(`RPC is not on ${options.network}. No transfer was attempted.`);
  const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_PROGRAM_ID);
  if (mintInfo.decimals !== 6) throw new Error('USDC mint decimals did not match the expected 6.');
  const destinationAta = getAssociatedTokenAddressSync(mint, destination, false, TOKEN_PROGRAM_ID);
  console.log(`${options.network} USDC mint: ${mint.toBase58()}`);
  console.log(`RPC: ${new URL(http).hostname}`);
  console.log(`Destination USDC account: ${destinationAta.toBase58()}`);
  console.log(`SOL fee reserve: ${formatUnits(reserve, 9)} SOL`);
  console.log(options.dryRun ? 'DRY RUN: no transactions will be sent.' : 'Live forwarding started. Press Ctrl+C to stop.');

  const tokenSubscriptions = new Map();
  let ownerSubscription;
  let programSubscription;
  let pollTimer;
  let scanTimer;
  let scanning = false;
  let pending = false;
  let stopping = false;

  async function refreshTokenSubscriptions(accounts) {
    if (options.dryRun) return;
    const current = new Set(accounts.map((a) => a.pubkey.toBase58()));
    for (const account of accounts) {
      const address = account.pubkey.toBase58();
      if (!tokenSubscriptions.has(address)) {
        const id = connection.onAccountChange(account.pubkey, requestScan, 'confirmed');
        tokenSubscriptions.set(address, id);
        log(`Watching USDC account ${address}`);
      }
    }
    for (const [address, id] of tokenSubscriptions) {
      if (!current.has(address)) {
        tokenSubscriptions.delete(address);
        await connection.removeAccountChangeListener(id).catch(() => {});
      }
    }
  }

  async function scan() {
    const parsed = await connection.getParsedTokenAccountsByOwner(source, { mint }, 'confirmed');
    const accounts = usdcAccounts(parsed, source, mint);
    await refreshTokenSubscriptions(accounts);
    let foundBalance = false;
    for (const account of accounts) {
      if (stopping) return;
      if (account.amount === 0n) continue;
      foundBalance = true;
      if (account.decimals !== mintInfo.decimals) {
        log(`Skipped ${account.pubkey.toBase58()}: token decimals mismatch.`);
        continue;
      }
      try {
        const createDestination = !(await connection.getAccountInfo(destinationAta, 'confirmed'));
        const { transaction } = buildUsdcTransfer({
          source, destination, mint, tokenAccount: account.pubkey,
          amount: account.amount, decimals: mintInfo.decimals, createDestination,
        });
        transaction.feePayer = source;
        transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
        const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value;
        if (fee === null) throw new Error('RPC could not estimate the USDC transaction fee.');
        const rent = createDestination ? await connection.getMinimumBalanceForRentExemption(165, 'confirmed') : 0;
        const balance = await connection.getBalance(source, 'confirmed');
        if (balance < fee + rent) {
          log(`USDC ${formatUnits(account.amount, 6)} waiting for SOL fees${createDestination ? ' and destination account creation' : ''}. Need at least ${formatUnits(fee + rent, 9)} SOL.`);
          continue;
        }
        if (options.dryRun) {
          log(`Would send ${formatUnits(account.amount, 6)} USDC from ${account.pubkey.toBase58()} to ${destination.toBase58()}. Estimated fee ${formatUnits(fee, 9)} SOL${createDestination ? `, destination account rent ${formatUnits(rent, 9)} SOL` : ''}.`);
          continue;
        }
        if (stopping) return;
        const signature = await sendAndConfirmTransaction(connection, transaction, [signer], {
          commitment: 'confirmed', preflightCommitment: 'confirmed',
        });
        log(`Sent ${formatUnits(account.amount, 6)} USDC. Signature: ${signature}`);
      } catch (error) {
        log(`USDC transfer failed for ${account.pubkey.toBase58()}: ${errorMessage(error)}`);
      }
    }

    try {
      if (stopping) return;
      const plan = await buildSolTransfer(connection, source, destination, reserve);
      if (!plan) {
        if (options.dryRun && !foundBalance) log('No spendable SOL or USDC found.');
        return;
      }
      if (options.dryRun) {
        log(`Would send ${formatUnits(plan.amount, 9)} SOL to ${destination.toBase58()}. Estimated fee ${formatUnits(plan.fee, 9)} SOL.`);
        return;
      }
      if (stopping) return;
      const signature = await sendAndConfirmTransaction(connection, plan.transaction, [signer], {
        commitment: 'confirmed', preflightCommitment: 'confirmed',
      });
      log(`Sent ${formatUnits(plan.amount, 9)} SOL. Signature: ${signature}`);
    } catch (error) {
      log(`SOL transfer failed: ${errorMessage(error)}`);
    }
  }

  async function runScan() {
    if (stopping) return;
    if (scanning) { pending = true; return; }
    scanning = true;
    try {
      await scan();
    } catch (error) {
      log(`Scan failed: ${errorMessage(error)}`);
    } finally {
      scanning = false;
      if (pending && !stopping) { pending = false; requestScan(); }
    }
  }

  function requestScan() {
    if (stopping || scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; void runScan(); }, 250);
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(pollTimer);
    clearTimeout(scanTimer);
    const removals = [...tokenSubscriptions.values()].map((id) => connection.removeAccountChangeListener(id));
    if (ownerSubscription !== undefined) removals.push(connection.removeAccountChangeListener(ownerSubscription));
    if (programSubscription !== undefined) removals.push(connection.removeProgramAccountChangeListener(programSubscription));
    await Promise.allSettled(removals);
    log('Stopped.');
  }

  if (options.dryRun) { await scan(); return; }
  ownerSubscription = connection.onAccountChange(source, requestScan, 'confirmed');
  programSubscription = connection.onProgramAccountChange(TOKEN_PROGRAM_ID, requestScan, 'confirmed', [
    { memcmp: { offset: 0, bytes: mint.toBase58() } },
    { memcmp: { offset: 32, bytes: source.toBase58() } },
  ]);
  pollTimer = setInterval(requestScan, 8_000);
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  await runScan();
}

main().catch((error) => {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
