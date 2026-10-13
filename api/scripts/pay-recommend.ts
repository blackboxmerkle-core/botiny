// One paid POST /v1/recommend (testnet only) via our own x402 client, accepting the bot ToS (hash bound into the EIP-3009 nonce).
// Key read from PAYER_PRIVATE_KEY; never printed. PAY_NETWORK selects the chain (default base-sepolia).
import { privateKeyToAccount } from "viem/accounts";
import { paidFetch } from "../src/payclient";
const raw = process.env.PAYER_PRIVATE_KEY; if (!raw) throw new Error("PAYER_PRIVATE_KEY not set");
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
const url = process.env.API_URL ?? "http://localhost:8402/v1/recommend";
(async () => {
  const params = { query: process.argv[2] ?? "x402 facilitator to settle USDC payments", k: Number(process.env.K ?? 3) };
  const r = await paidFetch(url, "/v1/recommend", params, JSON.stringify(params), { account, networks: [process.env.PAY_NETWORK ?? "base-sepolia"], maxAmount: 10_000n });
  const xpr = r.res.headers.get("x-payment-response");
  console.log(JSON.stringify({ status: r.res.status, payer: account.address, network: r.paid ? r.accept.network : null, tos: r.paid ? r.tos : null,
    payment_response: xpr ? JSON.parse(Buffer.from(xpr, "base64").toString("utf8")) : null, body: await r.res.json() }, null, 2));
})();
