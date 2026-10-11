/**
 * Supported EVM chains for x402 'exact' (EIP-3009 transferWithAuthorization) payments, settled by OUR relayer.
 * USDC addresses: Circle "USDC contract addresses" page (developers.circle.com/stablecoins/usdc-contract-addresses, checked 2026-10-11).
 * EIP-712 name/version: read on-chain (name()/version()) and DOMAIN_SEPARATOR recomputed and matched for every enabled testnet.
 * Mainnet entries exist for completeness but are hard-disabled: MAINNET_ALLOWED is a code constant, not an env flag.
 */
export const MAINNET_ALLOWED = false as const;
export interface EvmChain {
  key: string; caip2: string; chainId: number; label: string; rpc: string; usdc: `0x${string}`;
  eip712: { name: string; version: string }; explorer: string; native: string; testnet: boolean; enabled: boolean;
  minGasWei: bigint; note?: string;
}
const env = (k: string, d: string) => process.env[`RPC_${k.toUpperCase().replace(/-/g, "_")}`] ?? d;
const T = (key: string, chainId: number, label: string, rpc: string, usdc: string, name: string, explorer: string, native: string, minGasWei: bigint, extra: Partial<EvmChain> = {}): EvmChain =>
  ({ key, caip2: `eip155:${chainId}`, chainId, label, rpc: env(key, rpc), usdc: usdc as `0x${string}`, eip712: { name, version: "2" }, explorer, native, testnet: true, enabled: true, minGasWei, ...extra });
const M = (key: string, chainId: number, label: string, usdc: string, name: string, explorer: string, native: string): EvmChain =>
  ({ key, caip2: `eip155:${chainId}`, chainId, label, rpc: "", usdc: usdc as `0x${string}`, eip712: { name, version: "2" }, explorer, native, testnet: false, enabled: false, minGasWei: 0n, note: "mainnet: hard-disabled" });

export const CHAINS: EvmChain[] = [
  T("base-sepolia", 84532, "Base Sepolia", "https://sepolia.base.org", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", "https://sepolia.basescan.org", "ETH", 20_000_000_000_000n),
  T("sepolia", 11155111, "Ethereum Sepolia", "https://ethereum-sepolia-rpc.publicnode.com", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "USDC", "https://sepolia.etherscan.io", "ETH", 500_000_000_000_000n),
  T("arbitrum-sepolia", 421614, "Arbitrum Sepolia", "https://sepolia-rollup.arbitrum.io/rpc", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", "USD Coin", "https://sepolia.arbiscan.io", "ETH", 50_000_000_000_000n),
  T("optimism-sepolia", 11155420, "OP Sepolia", "https://sepolia.optimism.io", "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", "USDC", "https://sepolia-optimism.etherscan.io", "ETH", 20_000_000_000_000n),
  T("polygon-amoy", 80002, "Polygon Amoy", "https://polygon-amoy-bor-rpc.publicnode.com", "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", "USDC", "https://amoy.polygonscan.com", "POL", 20_000_000_000_000_000n),
  T("avalanche-fuji", 43113, "Avalanche Fuji", "https://api.avax-test.network/ext/bc/C/rpc", "0x5425890298aed601595a70AB815c96711a31Bc65", "USD Coin", "https://testnet.snowtrace.io", "AVAX", 5_000_000_000_000_000n),
  T("unichain-sepolia", 1301, "Unichain Sepolia", "https://sepolia.unichain.org", "0x31d0220469e10c4E71834a79b1f276d740d3768F", "USDC", "https://sepolia.uniscan.xyz", "ETH", 20_000_000_000_000n),
  T("worldchain-sepolia", 4801, "World Chain Sepolia", "https://worldchain-sepolia.g.alchemy.com/public", "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88", "USDC", "https://sepolia.worldscan.org", "ETH", 20_000_000_000_000n),
  T("linea-sepolia", 59141, "Linea Sepolia", "https://rpc.sepolia.linea.build", "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7", "USD//C", "https://sepolia.lineascan.build", "ETH", 50_000_000_000_000n,
    { enabled: false, note: "disabled: on-chain DOMAIN_SEPARATOR does not match name()/version()/chainId; EIP-712 domain unconfirmed" }),
  M("base", 8453, "Base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "https://basescan.org", "ETH"),
  M("ethereum", 1, "Ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USD Coin", "https://etherscan.io", "ETH"),
  M("arbitrum", 42161, "Arbitrum One", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "USD Coin", "https://arbiscan.io", "ETH"),
  M("optimism", 10, "OP Mainnet", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "USD Coin", "https://optimistic.etherscan.io", "ETH"),
  M("polygon", 137, "Polygon PoS", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USD Coin", "https://polygonscan.com", "POL"),
  M("avalanche", 43114, "Avalanche C-Chain", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USD Coin", "https://snowtrace.io", "AVAX"),
  M("unichain", 130, "Unichain", "0x078D782b760474a361dDA0AF3839290b0EF57AD6", "USDC", "https://uniscan.xyz", "ETH"),
  M("linea", 59144, "Linea", "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", "USDC", "https://lineascan.build", "ETH"),
  M("worldchain", 480, "World Chain", "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1", "USDC", "https://worldscan.org", "ETH"),
];
/** Optional allow-list: ENABLED_CHAINS=base-sepolia,sepolia (default: all enabled testnets). */
export function configuredChains(): EvmChain[] {
  const allow = (process.env.ENABLED_CHAINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return CHAINS.filter(c => c.enabled && c.testnet && (MAINNET_ALLOWED || c.testnet) && (!allow.length || allow.includes(c.key)));
}
/** Accepts v1 network names ("base-sepolia") and v2 CAIP-2 ids ("eip155:84532"). Never returns a mainnet. */
export function chainFor(network: string | undefined | null): EvmChain | null {
  if (!network) return null;
  const c = CHAINS.find(x => x.key === network || x.caip2 === network);
  if (!c || !c.testnet || !c.enabled) return null;
  return c;
}
export const explorerTx = (network: string | null | undefined, tx: string) => { const c = CHAINS.find(x => x.key === network || x.caip2 === network); return c ? `${c.explorer}/tx/${tx}` : null; };
export const publicChains = () => CHAINS.map(c => ({ key: c.key, caip2: c.caip2, chainId: c.chainId, label: c.label, usdc: c.usdc, eip712: c.eip712, explorer: c.explorer, native: c.native, testnet: c.testnet, enabled: c.enabled && c.testnet, note: c.note ?? null }));
