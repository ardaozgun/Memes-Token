// Vercel Serverless Function — /api/invested
//
// Net yatırılan parayı zincirden hesaplar:
//   net = (dışarıdan giren SOL/stablecoin, giriş anındaki USD değeriyle)
//       - (dışarı çıkan SOL/stablecoin, çıkış anındaki USD değeriyle)
//
// - Takip edilen cüzdanların kendi aralarındaki transferler sayılmaz.
// - Sadece "TRANSFER" tipi işlemler taranır (swap/alım-satım sayılmaz).
// - SOL için geçmiş fiyat: Binance halka açık veri (günlük). Stablecoin = $1.
// - Sonuç Vercel edge cache'te 12 saat tutulur (Helius kredisini korumak için).
//
// Cüzdan adresleri tarayıcıya gönderilmez; yalnızca toplam tutarlar döner.

const { getWallets, getApiKey } = require("./_lib");

const HELIUS_BASE = "https://api-mainnet.helius-rpc.com";
const BINANCE = "https://data-api.binance.vision/api/v3/klines";

// Dolar kabul edilen stablecoin'ler
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
]);

const MIN_SOL = 0.01; // bundan küçük SOL hareketleri (toz/spam/rent) sayılmaz
const MIN_USD = 1; // bundan küçük stablecoin hareketleri sayılmaz
const MAX_PAGES_PER_WALLET = 40; // cüzdan başına en fazla 40x100 işlem
const TIME_BUDGET_MS = 50000; // 50 sn'yi aşarsak durup elimizdekini döneriz

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Helius: bir cüzdanın TRANSFER işlemleri (sayfalı) ----
async function fetchTransfers(apiKey, wallet, deadline) {
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
      `?api-key=${apiKey}&type=TRANSFER&token-accounts=balanceChanged&limit=100`;
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

// ---- Binance: günlük SOL fiyatı (ohlc ortalaması) ----
async function solDailyPrices(fromMs, toMs) {
  const DAY = 86400000;
  const map = new Map(); // gün indeksi -> fiyat
  let start = Math.floor(fromMs / DAY) * DAY;

  while (start < toMs) {
    const url = `${BINANCE}?symbol=SOLUSDT&interval=1d&startTime=${start}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fiyat geçmişi alınamadı (${res.status})`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const day = Math.floor(Number(r[0]) / DAY);
      const o = Number(r[1]);
      const h = Number(r[2]);
      const l = Number(r[3]);
      const c = Number(r[4]);
      map.set(day, (o + h + l + c) / 4);
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    if (rows.length < 1000) break;
    start = lastOpen + DAY;
  }

  return map;
}

function priceAt(map, tsSec) {
  const DAY = 86400;
  const day = Math.floor(tsSec / DAY);
  if (map.has(day)) return map.get(day);
  // en yakın günü bul (±10 gün)
  for (let d = 1; d <= 10; d++) {
    if (map.has(day - d)) return map.get(day - d);
    if (map.has(day + d)) return map.get(day + d);
  }
  return null;
}

// ---- Asıl hesap ----
// Dönüş: { events: [{ts, kind:'sol'|'usd', amount, dir:+1|-1}] }
function extractEvents(wallet, walletSet, txs) {
  const events = [];
  for (const tx of txs) {
    const ts = Number(tx.timestamp);
    if (!ts) continue;

    for (const nt of tx.nativeTransfers || []) {
      const from = nt.fromUserAccount;
      const to = nt.toUserAccount;
      const sol = Number(nt.amount || 0) / 1e9;
      if (sol < MIN_SOL) continue;
      if (to === wallet && from !== wallet && !walletSet.has(from)) {
        events.push({ ts, kind: "sol", amount: sol, dir: +1 });
      } else if (from === wallet && to !== wallet && !walletSet.has(to)) {
        events.push({ ts, kind: "sol", amount: sol, dir: -1 });
      }
    }

    for (const tt of tx.tokenTransfers || []) {
      if (!STABLES.has(tt.mint)) continue;
      const from = tt.fromUserAccount;
      const to = tt.toUserAccount;
      const usd = Number(tt.tokenAmount || 0);
      if (usd < MIN_USD) continue;
      if (to === wallet && from !== wallet && !walletSet.has(from)) {
        events.push({ ts, kind: "usd", amount: usd, dir: +1 });
      } else if (from === wallet && to !== wallet && !walletSet.has(to)) {
        events.push({ ts, kind: "usd", amount: usd, dir: -1 });
      }
    }
  }
  return events;
}

async function computeInvested(apiKey, wallets) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const walletSet = new Set(wallets);

  // Cüzdanları paralel tara
  const results = await Promise.all(
    wallets.map((w) => fetchTransfers(apiKey, w, deadline))
  );

  let partial = false;
  const events = [];
  let txCount = 0;
  results.forEach((r, i) => {
    if (r.partial) partial = true;
    txCount += r.txs.length;
    events.push(...extractEvents(wallets[i], walletSet, r.txs));
  });

  const solEvents = events.filter((e) => e.kind === "sol");
  let priceMap = new Map();
  if (solEvents.length) {
    const minTs = Math.min(...solEvents.map((e) => e.ts));
    priceMap = await solDailyPrices(minTs * 1000 - 86400000, Date.now());
  }

  let deposited = 0;
  let withdrawn = 0;
  let unpriced = 0;

  for (const e of events) {
    let usd = null;
    if (e.kind === "usd") {
      usd = e.amount;
    } else {
      const p = priceAt(priceMap, e.ts);
      if (p == null) {
        unpriced += 1;
        continue;
      }
      usd = e.amount * p;
    }
    if (e.dir > 0) deposited += usd;
    else withdrawn += usd;
  }

  return {
    invested: deposited - withdrawn,
    deposited,
    withdrawn,
    eventCount: events.length,
    txCount,
    unpriced,
    partial,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // 1) Elle girilmiş değer varsa (INVESTED_USD) onu kullan — otomatik hesabı atlar.
  const manual = parseFloat(
    String(process.env.INVESTED_USD || "").replace(",", ".")
  );
  if (Number.isFinite(manual) && manual > 0) {
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).end(
      JSON.stringify({
        invested: manual,
        source: "manual",
        computedAt: Date.now(),
      })
    );
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(500).end(
      JSON.stringify({
        error: "config",
        message: "HELIUS_API_KEY ayarlı değil.",
      })
    );
    return;
  }

  try {
    const out = await computeInvested(apiKey, getWallets());
    // 12 saat taze, 1 gün boyunca eskiyi gösterip arka planda yenile
    res.setHeader(
      "Cache-Control",
      "s-maxage=43200, stale-while-revalidate=86400"
    );
    res.status(200).end(
      JSON.stringify({ ...out, source: "auto", computedAt: Date.now() })
    );
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

// test için dışa aç
module.exports._internal = { extractEvents, priceAt };
