import { readFile } from 'node:fs/promises';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export const USDC_MINTS = Object.freeze({
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
});
export const GENESIS_HASHES = Object.freeze({
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
});
export const DEFAULT_RESERVE_LAMPORTS = 5_000_000n;

export function parseKeypair(value) {
  let bytes;
  try {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      const array = JSON.parse(trimmed);
      if (!Array.isArray(array) || array.length !== 64 || array.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        throw new Error('Invalid keypair array.');
      }
      bytes = Uint8Array.from(array);
    } else {
      bytes = bs58.decode(trimmed);
    }
  } catch {
    throw new Error('Private key must be base58 or a Solana CLI JSON keypair array.');
  }
  if (bytes.length !== 64) {
    throw new Error('Expected a 64-byte Solana private key.');
  }
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('The private key is invalid.');
  }
}

export async function loadKeypair(path, secretPrompt) {
  if (path) return parseKeypair(await readFile(path, 'utf8'));
  return parseKeypair(await secretPrompt());
}

export function parseDestination(value, source) {
  let destination;
  try {
    destination = new PublicKey(value.trim());
  } catch {
    throw new Error('Destination is not a valid Solana address.');
  }
  if (destination.equals(source)) throw new Error('Destination must differ from the source wallet.');
  return destination;
}

export function parseReserveSol(value) {
  if (!/^\d+(?:\.\d{1,9})?$/.test(value)) throw new Error('Reserve must be a nonnegative SOL amount with at most 9 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

export function spendableLamports(balance, reserve, fee) {
  const amount = BigInt(balance) - BigInt(reserve) - BigInt(fee);
  return amount > 0n ? amount : 0n;
}

export function formatUnits(amount, decimals) {
  const raw = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / divisor}${fraction ? `.${fraction}` : ''}`;
}

export function usdcAccounts(parsedAccounts, owner, mint) {
  return parsedAccounts.value.filter(({ account }) => {
    const data = account.data;
    return account.owner.equals(TOKEN_PROGRAM_ID) &&
      data?.program === 'spl-token' &&
      data.parsed?.type === 'account' &&
      data.parsed.info?.owner === owner.toBase58() &&
      data.parsed.info?.mint === mint.toBase58();
  }).map(({ pubkey, account }) => ({
    pubkey,
    amount: BigInt(account.data.parsed.info.tokenAmount.amount),
    decimals: account.data.parsed.info.tokenAmount.decimals,
  }));
}

export async function buildSolTransfer(connection, source, destination, reserve) {
  const balance = await connection.getBalance(source, 'confirmed');
  if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('RPC returned an unsafe SOL balance.');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: source, recentBlockhash: blockhash });
  transaction.add(SystemProgram.transfer({ fromPubkey: source, toPubkey: destination, lamports: 1 }));
  const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value;
  if (fee === null) throw new Error('RPC could not estimate the SOL transfer fee.');
  const amount = spendableLamports(balance, reserve, fee);
  if (amount === 0n) return null;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SOL amount exceeds JavaScript safe integer range.');
  transaction.instructions[0] = SystemProgram.transfer({
    fromPubkey: source,
    toPubkey: destination,
    lamports: Number(amount),
  });
  return { transaction, amount, balance, fee };
}

export function buildUsdcTransfer({ source, destination, mint, tokenAccount, amount, decimals, createDestination }) {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > 18_446_744_073_709_551_615n) {
    throw new Error('USDC raw amount is outside the valid u64 range.');
  }
  if (decimals !== 6) throw new Error('USDC decimals must be 6.');
  const destinationAta = getAssociatedTokenAddressSync(mint, destination, false, TOKEN_PROGRAM_ID);
  const transaction = new Transaction();
  if (createDestination) transaction.add(createAssociatedTokenAccountIdempotentInstruction(
    source, destinationAta, destination, mint, TOKEN_PROGRAM_ID,
  ));
  transaction.add(createTransferCheckedInstruction(
    tokenAccount, mint, destinationAta, source, amount, decimals, [], TOKEN_PROGRAM_ID,
  ));
  return { transaction, destinationAta };
}
