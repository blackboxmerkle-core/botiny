import { createPublicClient, http, erc20Abi, formatUnits, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";
import { USDC_BASE_SEPOLIA } from "./payment";
export const PAYEE = (process.env.PAY_TO_ADDRESS || "0x0e66433540a91D9683E939c8Ac17BC084571D050") as `0x${string}`;
export const PAYER = (process.env.PAYER_ADDRESS || "0x0b68c3ecBB5DC0E79a4399eE7eA43d07Cb9A5402") as `0x${string}`; // public address only
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org") });
let cache: { at: number; data: any } | null = null;
export async function chainView(txs: string[]) {
  if (cache && Date.now() - cache.at < 30000 && txs.every(t => t in cache!.data.receipts)) return cache.data;
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
  for (const t of txs.filter(t => /^0x[0-9a-fA-F]{64}$/.test(t))) {
    try { const r = await client.getTransactionReceipt({ hash: t as `0x${string}` }); out.receipts[t] = r.status; }
    catch { out.receipts[t] = "not_found"; }
  }
  cache = { at: Date.now(), data: out };
  return out;
}
