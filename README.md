# Solana wallet forwarder

A local CLI that forwards confirmed SOL and official Circle USDC deposits from one Solana wallet to a destination wallet you enter each time it starts. It also checks balances already in the source wallet at startup. The source wallet signs its own transfers; no program or third party receives the private key.

## Run on Windows PowerShell

Install [Node.js 20 or later](https://nodejs.org/) if needed. Mainnet is the default. Put your own Helius key in an ignored `.env.local` file:

```text
HELIUS_API_KEY=your_key_here
```

Copy `.env.example` to `.env.local` and replace the placeholder with your key. `.env.local` is ignored by Git and is never part of the public repository. `npm.cmd run probe` checks Helius mainnet HTTP, official USDC mint, and a WebSocket subscription without loading a wallet or sending a transaction. The bot checks the network genesis hash before it can send.

Run in this folder:

```powershell
npm.cmd install
npm.cmd run probe
npm.cmd start -- --dry-run
npm.cmd start
```

`npm.cmd start` signs and sends real mainnet transfers after you confirm the destination. Keep the terminal running to keep forwarding deposits.

At each start, paste the **source** wallet's 64-byte base58 private key into the hidden prompt, then enter the **destination** wallet address twice. `--dry-run` reports the current transfers and exits without signing or sending. The live command keeps running until you press Ctrl+C. The destination address is never hard-coded.

You can use a local Solana CLI JSON keypair or a text file containing the base58 key instead of pasting it:

```powershell
npm.cmd start -- --keypair-file "C:\path\outside\this\repo\source-keypair.json"
```

Keep the key file private and outside this project. Do not paste your private key into chat, a URL, or an RPC setting. The program does not save the prompted key or destination. Avoid putting a private key on the command line, where it may be saved in shell history.

## Options

```powershell
npm.cmd start -- --network devnet --dry-run
npm.cmd start -- --rpc "https://YOUR_RPC_ENDPOINT" --ws "wss://YOUR_WS_ENDPOINT"
npm.cmd start -- --reserve-sol 0.01
npm.cmd start -- --reserve-sol 0
```

`SOLANA_RPC_URL` and `SOLANA_WS_URL` environment variables also work, as do `--rpc` and `--ws`. Those explicit settings take precedence over `HELIUS_API_KEY`. If none are set, the CLI uses Solana's public RPC for the selected network. The tool subscribes to source wallet changes and USDC token account changes, and scans every 8 seconds to recover from missed notifications. Transfers start after the RPC reports a deposit at **confirmed** commitment. Network and RPC delays mean there is no guaranteed instant delivery.

The default reserve is **0.005 SOL**. The tool forwards SOL above the reserve after estimating the transaction fee. It uses source wallet SOL to pay for USDC transfers and, if needed, creation of the destination's USDC token account. A wallet holding USDC but no SOL cannot forward that USDC until it receives enough SOL. Setting the reserve to zero drains spendable SOL and may leave future USDC without fee money. Existing source token accounts are not closed; their rent balance stays in those accounts.

Only native SOL and the official Circle USDC mint for the chosen network are handled. It does not forward bridged or lookalike tokens. Check the source, network, mint, destination, and dry run output before using live mode with funds. You can verify each logged signature on [Solana Explorer](https://explorer.solana.com/).

Run checks with `npm.cmd test`. Tests use generated throwaway keys and do not send a transaction.
Before relying on live forwarding, use a small amount in wallets you control and verify the logged transaction signature and destination balance. A successful probe or dry run does not prove that a real transfer has landed.

`npm audit` currently reports advisories in the legacy Solana JavaScript dependency chain, including a high-severity `bigint-buffer` advisory. The program checks token amounts before constructing transfers, but that does not replace a dependency security review. Keep the process and private key on a machine you control.

Sources: [Solana RPC account subscriptions](https://solana.com/docs/rpc/websocket/accountsubscribe), [Solana token transfer and token account docs](https://solana.com/docs/tokens/basics/transfer-tokens), [Solana's Circle USDC mint listing](https://solana.com/docs/payments/how-payments-work).
