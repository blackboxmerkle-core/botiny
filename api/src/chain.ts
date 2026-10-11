import { createPublicClient, http, erc20Abi, formatUnits, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";
import { USDC_BASE_SEPOLIA } from "./payment";
import { chainFor } from "./chains";
export const PAYEE = (process.env.PAY_TO_ADDRESS || "0x0e66433540a91D9683E939c8Ac17BC084571D050") as `0x${string}`;
export const PAYER = (process.env.PAYER_ADDRESS || "0x0b68c3ecBB5DC0E79a4399eE7eA43d07Cb9A5402") as `0x${string}`; // public address only
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org") });
let cache: { at: number; data: any } | null = null;
// Final receipt statuses never change: cache forever. 'not_found' is retried.
const receiptCache = new Map<string, string>();
export type TxRef = string | { tx: string; network?: string | null };
export async function chainView(txs: TxRef[]) {
  const fresh = cache && Date.now() - cache.at < 30000;
  if (fresh) { await fillReceipts(txs); return { ...cache!.data, receipts: Object.fromEntries(receiptCache) }; }
  const bal = (a: `0x${string}`) => client.readContract({ address: USDC_BASE_SEPOLIA as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const out: any = { network: "base-sepolia", chain_id: 84532, usdc: USDC_BASE_SEPOLIA, payee: PAYEE, payer: PAYER, receipts: {}, transfers: [], errors: [] };
  try {
    const [pe, pr, head, ee, er] = await Promise.all([bal(PAYEE), bal(PAYER), client.getBlockNumber(), client.getBalance({ address: PAYEE }), client.getBalance({ address: PAYER })]);
    out.balances = { payee: formatUnits(pe, 6), payer: formatUnits(pr, 6), payee_eth: formatUnits(ee, 18), payer_eth: formatUnits(er, 18) }; out.head = Number(head);
    // public RPC caps eth_getLogs at 200 blocks; scan WINDOW blocks (~2s/block) in 200-block chunks
    const WINDOW = BigInt(process.env.LOG_WINDOW_BLOCKS ?? "3000"), CH = 200n;
    const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    const ranges: [bigint, bigint][] = [];
    for (let to = head; to > head - WINDOW && to > 0n; to -= CH) ranges.push([to - CH + 1n > 0n ? to - CH + 1n : 0n, to]);
    const chunks = await Promise.all(ranges.map(([f, t]) => client.getLogs({ address: USDC_BASE_SEPOLIA as `0x${string}`, event: ev, args: { to: PAYEE }, fromBlock: f, toBlock: t })
      .catch((e: any) => { out.errors.push(`getLogs ${f}-${t}: ${e.shortMessage ?? e.message}`); return []; })));
    const logs = chunks.flat().sort((a, b) => Number(a.blockNumber - b.blockNumber));
    out.transfer_window_blocks = Number(WINDOW);
    out.transfers = logs.slice(-25).reverse().map(l => ({ tx: l.transactionHash, block: Number(l.blockNumber), from: l.args.from, value: formatUnits(l.args.value!, 6) }));
  } catch (e: any) { out.errors.push(String(e.shortMessage ?? e.message)); }
  await fillReceipts(txs);
  out.receipts = Object.fromEntries(receiptCache);
  cache = { at: Date.now(), data: out };
  return out;
}

const clients = new Map<string, any>();
function clientFor(network: string) {
  if (network === "base-sepolia") return client;
  if (!clients.has(network)) { const c = chainFor(network); clients.set(network, c ? createPublicClient({ transport: http(c.rpc, { timeout: 15000 }) }) : null); }
  return clients.get(network);
}
async function fillReceipts(txs: TxRef[]) {
  const refs = txs.map(t => typeof t === "string" ? { tx: t, network: "base-sepolia" } : { tx: t.tx, network: t.network || "base-sepolia" });
  const seen = new Set<string>();
  const todo = refs.filter(r => /^0x[0-9a-fA-F]{64}$/.test(r.tx) && (receiptCache.get(r.tx) ?? "not_found") === "not_found" && !seen.has(r.tx) && seen.add(r.tx));
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async r => {
      const c = clientFor(r.network); if (!c) { receiptCache.set(r.tx, "unknown_chain"); return; }
      try { receiptCache.set(r.tx, (await c.getTransactionReceipt({ hash: r.tx as `0x${string}` })).status); } catch { receiptCache.set(r.tx, "not_found"); }
    }));
  }
}
