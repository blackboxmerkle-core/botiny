// Deploy ClickAttestation to SKALE Europa TESTNET (chain 1444673419). Refuses any other chain.
//   ATTEST_PRIVATE_KEY=0x... [SKALE_EUROPA_TESTNET_RPC=...] npx tsx scripts/attest-deploy.ts sfuel    # PoW sFUEL from SKALE's on-chain faucet
//   ATTEST_PRIVATE_KEY=0x... npx tsx scripts/attest-deploy.ts deploy                                  # deploy, attester = same key
//   npx tsx scripts/attest-deploy.ts keygen <file>   # fresh throwaway TESTNET key written to <file> (mode 600, keep OUTSIDE the repo)
// The key is read from env only and never printed or written into the repo.
import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, encodeFunctionData, parseAbi, formatEther, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { artifact, assertTestnet, SKALE_EUROPA_TESTNET } from "../src/attest";

const RPC = process.env.SKALE_EUROPA_TESTNET_RPC ?? SKALE_EUROPA_TESTNET.rpc;
// SKALE Europa testnet sFUEL PoW faucet ("sFUEL station"): pay(address) selector 0x0c11dedd
const FAUCET = (process.env.SKALE_SFUEL_FAUCET ?? "0x366727B410fE55774C8b0B5b5A6E2d74199a088A") as Hex;
const chain = { id: SKALE_EUROPA_TESTNET.id, name: SKALE_EUROPA_TESTNET.name, nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

/** SKALE PoW gas: find candidate with (2^256-1)/(keccak(nonce)^keccak(addr)^keccak(candidate)) >= gas; use candidate as gasPrice. */
export function mineGasPrice(gas: number, address: Hex, nonce: number) {
  const nonceHash = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(nonce)])));
  const addrHash = BigInt(keccak256(address));
  const x = nonceHash ^ addrHash; const max = (1n << 256n) - 1n;
  for (;;) {
    const cand = BigInt("0x" + randomBytes(32).toString("hex"));
    const h = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [cand]))) ^ x;
    if (h !== 0n && max / h >= BigInt(gas)) return cand;
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "keygen") {
    const f = resolve(process.argv[3] ?? "");
    if (!process.argv[3] || f.startsWith(resolve(__dirname, "..", ".."))) throw new Error("give a key file path OUTSIDE the repo");
    if (existsSync(f)) throw new Error("refusing to overwrite " + f);
    const pk = generatePrivateKey(); writeFileSync(f, pk + "\n", { mode: 0o600 });
    console.log("wrote throwaway TESTNET key to", f, "address", privateKeyToAccount(pk).address); return;
  }
  const pk = process.env.ATTEST_PRIVATE_KEY as Hex;
  if (!pk) throw new Error("ATTEST_PRIVATE_KEY not set");
  const account = privateKeyToAccount(pk);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const wal = createWalletClient({ chain, account, transport: http(RPC) });
  const id = await pub.getChainId(); assertTestnet(id);
  if (id !== SKALE_EUROPA_TESTNET.id) throw new Error(`RPC is chain ${id}, expected SKALE Europa testnet ${SKALE_EUROPA_TESTNET.id}`);
  console.log("account", account.address, "balance", formatEther(await pub.getBalance({ address: account.address })), "sFUEL");
  if (cmd === "sfuel") {
    const gas = 100_000; const nonce = await pub.getTransactionCount({ address: account.address });
    const gasPrice = mineGasPrice(gas, account.address, nonce);
    const data = encodeFunctionData({ abi: parseAbi(["function pay(address receiver)"]), functionName: "pay", args: [account.address] });
    const hash = await wal.sendTransaction({ to: FAUCET, data, gas: BigInt(gas), gasPrice, nonce, type: "legacy" } as any);
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log("faucet tx", hash, rc.status, "balance", formatEther(await pub.getBalance({ address: account.address })), "sFUEL"); return;
  }
  if (cmd === "deploy") {
    const { abi, bytecode } = artifact();
    const attester = (process.env.ATTEST_ATTESTER ?? account.address) as Hex;
    const hash = await wal.deployContract({ abi, bytecode, args: [attester], type: "legacy" } as any);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error("deploy failed " + hash);
    const out = { network: "skale-europa-testnet", chain_id: id, contract: rc.contractAddress, tx: hash, block: Number(rc.blockNumber), owner: account.address, attester,
      explorer: `${SKALE_EUROPA_TESTNET.explorer}/address/${rc.contractAddress}`, deployed_at: new Date().toISOString() };
    const dir = join(__dirname, "..", "..", "contracts", "deployments"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skale-europa-testnet.json"), JSON.stringify(out, null, 2) + "\n");
    console.log(JSON.stringify(out, null, 2)); return;
  }
  throw new Error("usage: attest-deploy.ts keygen <file> | sfuel | deploy");
}
if (require.main === module) main().catch(e => { console.error(String(e?.shortMessage ?? e?.message ?? e), e?.details ?? "", e?.cause?.details ?? ""); process.exit(1); });
