// Ortak ayarlar — cüzdan adresleri BURADA (sunucuda) durur, tarayıcıya asla gönderilmez.
// Dosya adı "_" ile başladığı için Vercel bunu ayrı bir API olarak yayınlamaz.

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

function getApiKey() {
  return process.env.HELIUS_API_KEY || null;
}

function getRpcUrl() {
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return null;
}

module.exports = { getWallets, getRpcUrl, getApiKey };
