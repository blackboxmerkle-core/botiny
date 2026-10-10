import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
const raw = process.env.PAYER_PRIVATE_KEY; if (!raw) throw new Error("PAYER_PRIVATE_KEY not set");
const acct = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const bal = (a: `0x${string}`) => c.readContract({ address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", abi: erc20Abi, functionName: "balanceOf", args: [a] });
(async () => {
  const pt = "0x0e66433540a91D9683E939c8Ac17BC084571D050";
  console.log(JSON.stringify({ chainId: await c.getChainId(), payer: acct.address, payer_usdc: formatUnits(await bal(acct.address), 6), payer_eth: formatUnits(await c.getBalance({ address: acct.address }), 18), payTo_usdc: formatUnits(await bal(pt), 6) }));
})();
