import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  buildSolTransfer, buildUsdcTransfer, parseDestination, parseKeypair,
  parseReserveSol, spendableLamports, USDC_MINTS, usdcAccounts,
} from '../src/core.mjs';

test('accepts a valid local key in both supported formats and rejects malformed arrays', () => {
  const original = Keypair.generate();
  assert.equal(parseKeypair(bs58.encode(original.secretKey)).publicKey.toBase58(), original.publicKey.toBase58());
  assert.equal(parseKeypair(JSON.stringify([...original.secretKey])).publicKey.toBase58(), original.publicKey.toBase58());
  const malformed = [...original.secretKey];
  malformed[0] = -1;
  assert.throws(() => parseKeypair(JSON.stringify(malformed)));
});

test('destination must be valid and different from the source', () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  assert.equal(parseDestination(destination.toBase58(), source).toBase58(), destination.toBase58());
  assert.throws(() => parseDestination(source.toBase58(), source));
  assert.throws(() => parseDestination('not-an-address', source));
});

test('SOL reserve and fee arithmetic is exact in lamports', () => {
  assert.equal(parseReserveSol('0.005'), 5_000_000n);
  assert.equal(parseReserveSol('0.000000001'), 1n);
  assert.throws(() => parseReserveSol('0.0000000001'));
  assert.equal(spendableLamports(10_000_000, 5_000_000n, 5_000), 4_995_000n);
  assert.equal(spendableLamports(5_000, 5_000_000n, 5_000), 0n);
});

test('SOL transaction sends only balance minus fee and reserve', async () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const connection = {
    getBalance: async () => 10_000_000,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
    getFeeForMessage: async () => ({ value: 5_000 }),
  };
  const result = await buildSolTransfer(connection, source, destination, 5_000_000n);
  assert.equal(result.amount, 4_995_000n);
  assert.equal(result.transaction.instructions[0].keys[1].pubkey.toBase58(), destination.toBase58());
  assert.equal(result.transaction.instructions[0].data.readBigUInt64LE(4), result.amount);
});

test('only the specified USDC mint and owner accounts are forwarded', () => {
  const owner = Keypair.generate().publicKey;
  const mint = new PublicKey(USDC_MINTS.mainnet);
  const makeAccount = (mintAddress, ownerAddress) => ({
    pubkey: Keypair.generate().publicKey,
    account: {
      owner: TOKEN_PROGRAM_ID,
      data: { program: 'spl-token', parsed: { type: 'account', info: {
        mint: mintAddress, owner: ownerAddress,
        tokenAmount: { amount: '1234567', decimals: 6 },
      } } },
    },
  });
  const matching = makeAccount(mint.toBase58(), owner.toBase58());
  const parsed = { value: [matching, makeAccount(Keypair.generate().publicKey.toBase58(), owner.toBase58()), makeAccount(mint.toBase58(), Keypair.generate().publicKey.toBase58())] };
  const result = usdcAccounts(parsed, owner, mint);
  assert.equal(result.length, 1);
  assert.equal(result[0].amount, 1_234_567n);
});

test('USDC transaction creates the destination ATA when needed and transfers full raw amount', () => {
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const mint = new PublicKey(USDC_MINTS.mainnet);
  const tokenAccount = Keypair.generate().publicKey;
  const { transaction, destinationAta } = buildUsdcTransfer({
    source, destination, mint, tokenAccount, amount: 1_234_567n, decimals: 6, createDestination: true,
  });
  assert.equal(transaction.instructions.length, 2);
  assert.equal(transaction.instructions[1].keys[0].pubkey.toBase58(), tokenAccount.toBase58());
  assert.equal(transaction.instructions[1].keys[2].pubkey.toBase58(), destinationAta.toBase58());
  assert.equal(transaction.instructions[1].data.readBigUInt64LE(1), 1_234_567n);
  assert.throws(() => buildUsdcTransfer({
    source, destination, mint, tokenAccount, amount: 2n ** 64n, decimals: 6, createDestination: false,
  }));
});
