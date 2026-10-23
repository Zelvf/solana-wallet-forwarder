#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { GENESIS_HASHES, USDC_MINTS } from './core.mjs';

loadEnv({ path: fileURLToPath(new URL('../.env.local', import.meta.url)), quiet: true });

async function probeWebSocket(url, address) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    const timer = setTimeout(() => finish(new Error('WebSocket subscription timed out.')), 15_000);
    let done = false;
    function finish(error, subscriptionId) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close();
      error ? reject(error) : resolve(subscriptionId);
    }
    socket.on('open', () => socket.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'accountSubscribe',
      params: [address, { commitment: 'confirmed' }],
    })));
    socket.on('message', (raw) => {
      try {
        const response = JSON.parse(raw.toString());
        if (response.id === 1) {
          if (typeof response.result === 'number') finish(null, response.result);
          else finish(new Error('WebSocket subscription was rejected.'));
        }
      } catch { finish(new Error('Invalid WebSocket response.')); }
    });
    socket.on('error', () => finish(new Error('WebSocket connection failed.')));
    socket.on('close', () => finish(new Error('WebSocket closed before subscribing.')));
  });
}

async function main() {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Set a valid HELIUS_API_KEY in .env.local.');
  const encoded = encodeURIComponent(key);
  const http = `https://mainnet.helius-rpc.com/?api-key=${encoded}`;
  const ws = `wss://mainnet.helius-rpc.com/?api-key=${encoded}`;
  const connection = new Connection(http, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis !== GENESIS_HASHES.mainnet) throw new Error('Helius RPC did not report Solana mainnet.');
  const mint = await getMint(connection, new PublicKey(USDC_MINTS.mainnet), 'confirmed', TOKEN_PROGRAM_ID);
  if (mint.decimals !== 6) throw new Error('Mainnet USDC mint did not report 6 decimals.');
  await probeWebSocket(ws, Keypair.generate().publicKey.toBase58());
  console.log('Helius mainnet HTTP, official USDC mint, and account WebSocket subscription: OK.');
  console.log('No wallet was loaded and no transaction was sent.');
}

main().catch(() => {
  console.error('Helius probe failed. Check the local API key, plan limits, and connectivity.');
  process.exitCode = 1;
});
