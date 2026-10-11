// One paid POST /v1/recommend on Base Sepolia (testnet only). Key read from PAYER_PRIVATE_KEY; never printed.
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
const raw = process.env.PAYER_PRIVATE_KEY; if (!raw) throw new Error("PAYER_PRIVATE_KEY not set");
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") }).extend(publicActions);
if (wallet.chain.id !== 84532) throw new Error("refusing: not Base Sepolia");
const url = process.env.API_URL ?? "http://localhost:8402/v1/recommend";
const pay = wrapFetchWithPayment(fetch, wallet as any, BigInt(10000)); // max 0.01 USDC
(async () => {
  const r = await pay(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: process.argv[2] ?? "x402 facilitator to settle USDC payments", k: 3 }) });
  const xpr = r.headers.get("x-payment-response");
  console.log(JSON.stringify({ status: r.status, payer: account.address, payment_response: xpr ? decodeXPaymentResponse(xpr) : null, body: await r.json() }, null, 2));
})();
