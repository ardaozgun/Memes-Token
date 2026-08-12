// Vercel Serverless Function — /api/portfolio
// Cüzdan adresleri BURADA (sunucuda) durur, tarayıcıya asla gönderilmez.
// İstemciye yalnızca varlık (coin) verisi döner.

// ---- Takip edilecek cüzdanlar ----
// İstersen Vercel'de WALLETS env değişkeni ile de geçebilirsin (virgülle ayır).
const DEFAULT_WALLETS = [
  "ExMbkJpD8q2fYkYMe6bF8so4nJN3VpxKM52BT1McgWyn",
     "FowSbC2UQ8vA1cA9BFGgyEgxo8brr97NeK7Di4EvKMou",
     "CGty1jEPu9TkRypFSUEasSskMNgQeHRsBwdzk9SVJ5Sa",
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
  }
  return null;
}

// Bir cüzdanın tüm fungible token'larını + native SOL bakiyesini çeker (sayfalı).
async function heliusAssets(rpcUrl, owner) {
  const items = [];
  let native = null;
  let page = 1;

  while (page <= 10) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "portfolio",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: owner,
          page,
          limit: 1000,
          displayOptions: {
            showFungible: true,
            showNativeBalance: true,
            showZeroBalance: false,
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Helius ${res.status}: ${text.slice(0, 160)}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(
        `Helius: ${json.error.message || JSON.stringify(json.error)}`
      );
    }

    const result = json.result || {};
    if (result.nativeBalance) native = result.nativeBalance;
    const batch = result.items || [];
    items.push(...batch);

    if (batch.length < 1000) break;
    page += 1;
  }

  return { items, native };
}

// Jupiter'dan USD fiyat + 24s değişim (keysiz, 50'lik gruplar halinde).
async function jupiterPrices(mints) {
  const out = {};
  const unique = [...new Set(mints)];

  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    try {
      const res = await fetch(`${JUP_PRICE}?ids=${chunk.join(",")}`);
      if (!res.ok) continue;
      const json = await res.json();
      const data = json.data || json; // v3 düz obje döner, v2 data ile sarar
      for (const [mint, info] of Object.entries(data)) {
        if (info && typeof info === "object") {
          const price = Number(info.usdPrice ?? info.price ?? 0);
          if (!Number.isFinite(price)) continue;
          out[mint] = {
            price,
            change24h:
              info.priceChange24h != null ? Number(info.priceChange24h) : null,
          };
        }
      }
    } catch (_) {
      // bu grup atlanır, diğerlerine devam
    }
  }

  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Vercel edge cache: 30 sn taze, 60 sn içinde arka planda yenile
  res.setHeader(
    "Cache-Control",
    "s-maxage=30, stale-while-revalidate=60"
  );

  const rpcUrl = getRpcUrl();
  if (!rpcUrl) {
    res.status(500).end(
      JSON.stringify({
        error: "config",
        message:
          "HELIUS_API_KEY ayarlı değil. Vercel > Settings > Environment Variables kısmından ekle.",
      })
    );
    return;
  }

  try {
    const wallets = getWallets();

    // Tüm cüzdanları paralel çek
    const results = await Promise.all(
      wallets.map((w) => heliusAssets(rpcUrl, w))
    );

    // mint -> birleşik varlık
    const byMint = new Map();

    const addAmount = (mint, meta, amount) => {
      if (!(amount > 0)) return;
      const cur = byMint.get(mint);
      if (cur) {
        cur.amount += amount;
      } else {
        byMint.set(mint, { mint, amount, ...meta });
      }
    };

    let solLamports = 0;
    let solHeliusPrice = null;

    for (const { items, native } of results) {
      if (native && native.lamports) {
        solLamports += Number(native.lamports);
        if (native.price_per_sol) solHeliusPrice = Number(native.price_per_sol);
      }

      for (const it of items) {
        const iface = it.interface || "";
        // NFT'leri ele: sadece fungible token'lar
        if (iface && !/Fungible/i.test(iface)) continue;

        const ti = it.token_info || {};
        const decimals = Number(ti.decimals ?? 0);
        const rawBal = Number(ti.balance ?? 0);
        if (!(rawBal > 0)) continue;

        const amount = rawBal / Math.pow(10, decimals);
        const meta = it.content && it.content.metadata ? it.content.metadata : {};
        const links = it.content && it.content.links ? it.content.links : {};
        const symbol = (ti.symbol || meta.symbol || "").trim();
        const name = (meta.name || symbol || "").trim();
        const image =
          links.image ||
          (it.content &&
            it.content.files &&
            it.content.files[0] &&
            it.content.files[0].uri) ||
          null;
        const heliusPrice =
          ti.price_info && ti.price_info.price_per_token != null
            ? Number(ti.price_info.price_per_token)
            : null;

        addAmount(it.id, { symbol, name, image, decimals, heliusPrice }, amount);
      }
    }

    // Native SOL'u tek satır olarak ekle
    if (solLamports > 0) {
      addAmount(
        SOL_MINT,
        {
          symbol: "SOL",
          name: "Solana",
          image: SOL_LOGO,
          decimals: 9,
          heliusPrice: solHeliusPrice,
        },
        solLamports / 1e9
      );
    }

    // Fiyatları çek
    const mints = [...byMint.keys()];
    const prices = await jupiterPrices(mints);

    let totalValue = 0;
    let totalPrev = 0; // 24s önceki tahmini toplam
    const tokens = [];

    for (const t of byMint.values()) {
      const jp = prices[t.mint];
      const price = jp && jp.price > 0 ? jp.price : t.heliusPrice || 0;
      const change24h = jp ? jp.change24h : null;

      if (!(price > 0)) continue; // fiyatı olmayan (genelde scam/dust) atlanır
      const value = t.amount * price;
      if (value < 0.01) continue; // toz bakiyeleri gizle

      totalValue += value;
      if (change24h != null && Number.isFinite(change24h)) {
        const prevPrice = price / (1 + change24h / 100);
        totalPrev += t.amount * prevPrice;
      } else {
        totalPrev += value;
      }

      tokens.push({
        symbol: t.symbol || t.mint.slice(0, 4),
        name: t.name || t.symbol || "Bilinmeyen",
        image: t.image,
        amount: t.amount,
        price,
        value,
        change24h,
      });
    }

    tokens.sort((a, b) => b.value - a.value);

    const portfolioChange =
      totalPrev > 0 ? ((totalValue - totalPrev) / totalPrev) * 100 : null;

    res.status(200).end(
      JSON.stringify({
        totalValue,
        change24h: portfolioChange,
        tokenCount: tokens.length,
        walletCount: wallets.length,
        updatedAt: Date.now(),
        tokens,
      })
    );
  } catch (err) {
    res.status(500).end(
      JSON.stringify({
        error: "fetch",
        message: String((err && err.message) || err),
      })
    );
  }
};
