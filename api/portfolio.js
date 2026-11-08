// Vercel Serverless Function — /api/portfolio
// Cüzdan adresleri BURADA (sunucuda) durur, tarayıcıya asla gönderilmez.
// İstemciye yalnızca varlık (coin) verisi döner.

// ---- Takip edilecek cüzdanlar ----
// İstersen Vercel'de WALLETS env değişkeni ile de geçebilirsin (virgülle ayır).
const DEFAULT_WALLETS = [
"ExMbkJpD8q2fYkYMe6bF8so4nJN3VpxKM52BT1McgWyn",
"FowSbC2UQ8vA1cA9BFGgyEgxo8brr97NeK7Di4EvKMou",
"CGty1jEPu9TkRypFSUEasSskMNgQeHRsBwdzk9SVJ5Sa",
"GawuNosE3V3TPcvwAS8WHu48wQE3gnicEQD9oWhD5q85",
"5EgKagCGmJoqF1XE9BQgbcaGE94MubytK8CAPvv6ak3t",
   "98UF8K9KETcAwY9iob4XUMGc4UwV8K8pT6EQbsVeuKmr",

];

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_LOGO =
"https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";

function getWallets() {
const env = process.env.WALLETS;
if (env && env.trim()) {
return env
.split(",")
.map((s) => s.trim())
.filter(Boolean);
}
return DEFAULT_WALLETS;
}

function getRpcUrl() {
if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
if (process.env.HELIUS_API_KEY) {
return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
