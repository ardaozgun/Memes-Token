// Vercel Serverless Function — /api/pnl
//
// İşlem bazlı kar/zarar: her coin için
//   - toplam ALIM maliyeti (USD, alım anındaki fiyatla)
//   - toplam SATIŞ geliri (USD, satış anındaki fiyatla)
// hesaplar. Elde tutulan coin'in güncel değeri tarayıcıda eklenir:
//   kar/zarar = satış geliri + güncel değer - alım maliyeti
//
// Nasıl okur: Helius'tan SWAP işlemlerini çeker; her işlemde cüzdanın SOL ve
// stablecoin değişimine bakar. Bir coin artıp SOL/stablecoin azaldıysa ALIM,
// coin azalıp SOL/stablecoin arttıysa SATIŞ sayılır.
//
// Cüzdan adresleri tarayıcıya gönderilmez, sadece coin bazlı toplamlar döner.

const { getWallets, getApiKey, getRpcUrl } = require("./_lib");

const HELIUS_BASE = "https://api-mainnet.helius-rpc.com";
const BINANCE = "https://data-api.binance.vision/api/v3/klines";

const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
]);

const MIN_USD = 0.1; // bundan küçük alım/satımlar sayılmaz
const MAX_PAGES_PER_WALLET = 50; // cüzdan başına en fazla 50x100 swap
const TIME_BUDGET_MS = 48000; // süre dolarsa durup elimizdekini döneriz
const MAX_META = 2500; // en fazla bu kadar coin için isim/logo çekilir

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Helius: SWAP işlemleri (sayfalı) ----------
async function fetchSwaps(apiKey, wallet, deadline) {
  const txs = [];
  let before = null;
  let partial = false;

  for (let page = 0; page < MAX_PAGES_PER_WALLET; page++) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }

    let url =
      `${HELIUS_BASE}/v0/addresses/${wallet}/transactions` +
      `?api-key=${apiKey}&type=SWAP&token-accounts=balanceChanged&limit=100`;
    if (before) url += `&before=${before}`;

    let batch = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Helius ${res.status}: ${t.slice(0, 140)}`);
      }
      batch = await res.json();
      break;
    }
    if (batch === null) {
      partial = true;
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    txs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 100) break;
    if (page === MAX_PAGES_PER_WALLET - 1) partial = true;
  }

  return { txs, partial };
}

// ---------- Binance: günlük SOL fiyatı ----------
async function solDailyPrices(fromMs, toMs) {
  const DAY = 86400000;
  const map = new Map();
  let start = Math.floor(fromMs / DAY) * DAY;

  while (start < toMs) {
    const url = `${BINANCE}?symbol=SOLUSDT&interval=1d&startTime=${start}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fiyat geçmişi alınamadı (${res.status})`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const day = Math.floor(Number(r[0]) / DAY);
      map.set(day, (Number(r[1]) + Number(r[2]) + Number(r[3]) + Number(r[4])) / 4);
    }
    if (rows.length < 1000) break;
    start = Number(rows[rows.length - 1][0]) + DAY;
  }
  return map;
}

function priceAt(map, tsSec) {
  const day = Math.floor(tsSec / 86400);
  if (map.has(day)) return map.get(day);
  for (let d = 1; d <= 10; d++) {
    if (map.has(day - d)) return map.get(day - d);
    if (map.has(day + d)) return map.get(day + d);
  }
  return null;
}

// ---------- Bir işlemde cüzdanın net değişimi ----------
function walletDeltas(wallet, tx) {
  let sol = 0; // SOL (+ wSOL)
  const tokens = new Map(); // mint -> miktar değişimi

  for (const a of tx.accountData || []) {
    if (a.account === wallet) sol += Number(a.nativeBalanceChange || 0) / 1e9;
    for (const tb of a.tokenBalanceChanges || []) {
      if (tb.userAccount !== wallet) continue;
      const raw = tb.rawTokenAmount || {};
      const amt =
        Number(raw.tokenAmount || 0) / Math.pow(10, Number(raw.decimals || 0));
      if (!amt) continue;
      if (tb.mint === WSOL) sol += amt;
      else tokens.set(tb.mint, (tokens.get(tb.mint) || 0) + amt);
    }
  }
  return { sol, tokens };
}

// null: alım/satım değil (ya da ayrıştırılamadı)
function classify(wallet, tx, solPrice) {
  const { sol, tokens } = walletDeltas(wallet, tx);

  let quote = sol * solPrice; // SOL + stablecoin toplam USD değişimi
  const others = [];
  for (const [mint, amt] of tokens) {
    if (STABLES.has(mint)) quote += amt;
    else others.push([mint, amt]);
  }

  if (others.length === 0) return { kind: "none" };
  if (others.length > 1) return { kind: "skipped" };

  const [mint, qty] = others[0];
  if (qty > 0 && quote < -MIN_USD) {
    return { kind: "buy", mint, usd: -quote, qty };
  }
  if (qty < 0 && quote > MIN_USD) {
    return { kind: "sell", mint, usd: quote, qty: -qty };
  }
  return { kind: "skipped" };
}

// ---------- Coin isim/logo (Helius DAS getAssetBatch) ----------
async function fetchMeta(rpcUrl, mints, deadline) {
  const meta = new Map();
  for (let i = 0; i < mints.length; i += 500) {
    if (Date.now() > deadline) break;
    const ids = mints.slice(i, i + 500);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "meta",
          method: "getAssetBatch",
          params: { ids },
        }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      for (const a of json.result || []) {
        if (!a || !a.id) continue;
        const md = (a.content && a.content.metadata) || {};
        const ti = a.token_info || {};
        const links = (a.content && a.content.links) || {};
        meta.set(a.id, {
          symbol: String(ti.symbol || md.symbol || "").trim().slice(0, 24),
          name: String(md.name || "").trim().slice(0, 48),
          image: links.image || null,
        });
      }
    } catch (_) {
      // bu grup atlanır
    }
  }
  return meta;
}

// ---------- Ana hesap ----------
async function compute(apiKey, rpcUrl, wallets) {
  const start = Date.now();
  const deadline = start + TIME_BUDGET_MS;

  const results = await Promise.all(
    wallets.map((w) => fetchSwaps(apiKey, w, deadline))
  );

  let partial = false;
  let txCount = 0;
  let minTs = Infinity;
  for (const r of results) {
    if (r.partial) partial = true;
    txCount += r.txs.length;
    for (const tx of r.txs) {
      const ts = Number(tx.timestamp);
      if (ts && ts < minTs) minTs = ts;
    }
  }

  let priceMap = new Map();
  if (txCount > 0 && Number.isFinite(minTs)) {
    priceMap = await solDailyPrices(minTs * 1000 - 86400000, Date.now());
  }

  const byMint = new Map();
  const trades = []; // tek tek alım/satımlar (işlem geçmişi için)
  let skipped = 0;
  let unpriced = 0;
  const seen = new Set(); // aynı cüzdan+işlem iki kez sayılmasın

  results.forEach((r, i) => {
    const wallet = wallets[i];
    for (const tx of r.txs) {
      const key = wallet + ":" + tx.signature;
      if (seen.has(key)) continue;
      seen.add(key);

      const ts = Number(tx.timestamp);
      if (!ts) continue;
      const p = priceAt(priceMap, ts);
      if (p == null) {
        unpriced += 1;
        continue;
      }

      const c = classify(wallet, tx, p);
      if (c.kind === "none") continue;
      if (c.kind === "skipped") {
        skipped += 1;
        continue;
      }

      trades.push({ ts, mint: c.mint, side: c.kind, usd: c.usd, qty: c.qty });

      let t = byMint.get(c.mint);
      if (!t) {
        t = {
          mint: c.mint,
          bought: 0,
          sold: 0,
          qtyBought: 0,
          qtySold: 0,
          buys: 0,
          sells: 0,
          firstBuy: null,
          lastSell: null,
        };
        byMint.set(c.mint, t);
      }
      if (c.kind === "buy") {
        t.bought += c.usd;
        t.qtyBought += c.qty;
        t.buys += 1;
        if (t.firstBuy == null || ts < t.firstBuy) t.firstBuy = ts;
      } else {
        t.sold += c.usd;
        t.qtySold += c.qty;
        t.sells += 1;
        if (t.lastSell == null || ts > t.lastSell) t.lastSell = ts;
      }
    }
  });

  // Hiç alımı olmayan coin'ler (sadece satış görünenler) hesaba katılmaz:
  // maliyeti bilinmiyor (airdrop / başka yerden gelmiş olabilir).
  const withBuys = [...byMint.values()].filter((t) => t.bought > 0);
  const noCost = byMint.size - withBuys.length;

  // İşlem geçmişi: eskiden yeniye gez, her satışın kar/zararını
  // ortalama maliyet yöntemiyle bul (aynı coin'in tüm alımları birleşik sayılır).
  const buyMints = new Set(withBuys.map((t) => t.mint));
  const ordered = trades
    .filter((tr) => buyMints.has(tr.mint))
    .sort((a, b) => a.ts - b.ts);
  const pos = new Map(); // mint -> { qty, cost }
  const history = [];
  for (const tr of ordered) {
    let ps = pos.get(tr.mint);
    if (!ps) {
      ps = { qty: 0, cost: 0 };
      pos.set(tr.mint, ps);
    }
    if (tr.side === "buy") {
      ps.qty += tr.qty;
      ps.cost += tr.usd;
      history.push({ ts: tr.ts, mint: tr.mint, side: "buy", usd: tr.usd, qty: tr.qty });
    } else {
      let pnl = null;
      let basis = null;
      if (ps.qty > 0) {
        const used = Math.min(tr.qty, ps.qty);
        basis = (ps.cost / ps.qty) * used;
        // satılan adedin maliyeti; fazla satış (maliyeti bilinmeyen kısım) hesaba katılmaz
        const proceeds = tr.usd * (used / tr.qty);
        pnl = proceeds - basis;
        ps.qty -= used;
        ps.cost -= basis;
        if (ps.qty < 1e-9) {
          ps.qty = 0;
          ps.cost = 0;
        }
      }
      history.push({ ts: tr.ts, mint: tr.mint, side: "sell", usd: tr.usd, qty: tr.qty, pnl, basis });
    }
  }
  history.sort((a, b) => b.ts - a.ts); // en yeni en üstte
  const recentTrades = history.slice(0, 400);

  // En çok işlem hacmi olanlar için isim/logo çek
  withBuys.sort((a, b) => b.bought + b.sold - (a.bought + a.sold));
  const metaMints = withBuys.slice(0, MAX_META).map((t) => t.mint);
  const meta = await fetchMeta(rpcUrl, metaMints, start + 58000);

  const tokens = withBuys.map((t) => {
    const m = meta.get(t.mint) || {};
    return {
      mint: t.mint,
      symbol: m.symbol || t.mint.slice(0, 4),
      name: m.name || "",
      image: m.image || null,
      bought: t.bought,
      sold: t.sold,
      qtyBought: t.qtyBought,
      qtySold: t.qtySold,
      buys: t.buys,
      sells: t.sells,
      firstBuy: t.firstBuy,
      lastSell: t.lastSell,
    };
  });

  return {
    tokens,
    trades: recentTrades,
    tradeTotal: history.length,
    txCount,
    skipped,
    unpriced,
    noCost,
    partial,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const apiKey = getApiKey();
  const rpcUrl = getRpcUrl();
  if (!apiKey || !rpcUrl) {
    res.status(500).end(
      JSON.stringify({
        error: "config",
        message: "HELIUS_API_KEY ayarlı değil.",
      })
    );
    return;
  }

  try {
    const out = await compute(apiKey, rpcUrl, getWallets());
    // 30 dk taze; 1 gün boyunca eskiyi gösterip arka planda yenile
    res.setHeader(
      "Cache-Control",
      "s-maxage=1800, stale-while-revalidate=86400"
    );
    res.status(200).end(JSON.stringify({ ...out, computedAt: Date.now() }));
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(500).end(
      JSON.stringify({
        error: "fetch",
        message: String((err && err.message) || err),
      })
    );
  }
};
