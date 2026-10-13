# contracts/: TESTNET ONLY

## ClickAttestation (SKALE Europa testnet)
Public per-click attestation feed for Botiny advertisers (`src/ClickAttestation.sol`, Foundry, no external libs).
- `attestBatch(ClickIn[])` emits `Click(linkHash, clickHash, campaignHash, status, reason, at)` per click (three indexed hashes); known clickHashes are skipped (idempotent retries). One storage slot per click (~30k gas).
- `updateStatusBatch(StatusIn[])` emits `StatusUpdate(clickHash, campaignHash, status, reason, at)`; campaignHash must match; unchanged statuses skipped.
- Status codes: 1 paid, 2 filtered, 3 held, 4 clawed, 5 vested. Reason codes: `api/src/attest.ts` (`REASONS` / `REASON_NAME`).
- Only `isAttester` addresses can write; `owner` manages attesters.
- Hashes (no personal data on chain): `linkHash = keccak256("botiny.link.v1|" + short_code)`,
  `clickHash = keccak256("botiny.click.v1|" + daily-salted visitor key + "|" + click_id)`,
  `campaignHash = keccak256("botiny.campaign.v1|" + advertiser salt + "|" + advertiser_id + "|" + listing_id)`.

Test: `forge test` (cheatcodes via a minimal `test/Vm.sol`, works offline). ABI + bytecode for the API: `abi/ClickAttestation.json`
(regenerate after changes: `forge build` then copy abi/bytecode as done in the commit).

## Network
SKALE Europa Hub **testnet**: chain id `1444673419`, RPC `https://testnet.skalenodes.com/v1/juicy-low-small-testnet`,
explorer `https://juicy-low-small-testnet.explorer.testnet.skalenodes.com`. Gas token sFUEL (free; zero-value gas).
Mainnet (2046399126) is refused by the deploy script and the attestation worker.

## Deploy
```
cd api
npx tsx scripts/attest-deploy.ts keygen /path/outside/repo/attester.key        # optional: fresh throwaway testnet key
export ATTEST_PRIVATE_KEY=$(cat /path/outside/repo/attester.key)              # never commit
npx tsx scripts/attest-deploy.ts sfuel     # SKALE PoW sFUEL faucet (on-chain, pay(address) at 0x3667…088A)
npx tsx scripts/attest-deploy.ts deploy    # writes contracts/deployments/skale-europa-testnet.json
```
Then run the API with `CLICK_ATTEST_CONTRACT=<address>`, `ATTEST_PRIVATE_KEY`, optional `CLICK_ATTEST_FROM_BLOCK=<deploy block>`,
`CLICK_ATTEST_INTERVAL_MS` (default 15000), `CLICK_ATTEST_BATCH` (100).
