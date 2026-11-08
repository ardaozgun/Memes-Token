export default function handler(req, res) {
    // Kendi coin/hisse maliyetlerini ve miktarlarını buraya gir
    const assets = [
        { symbol: "BTC", amount: 0.5, buyPrice: 40000, currentPrice: 65000 },
        { symbol: "ETH", amount: 5, buyPrice: 2000, currentPrice: 3500 },
        { symbol: "ARC", amount: 1000, buyPrice: 0.50, currentPrice: 0.40 } 
    ];

    let totalInvested = 0;
    let currentTotal = 0;

    const detailedAssets = assets.map(asset => {
        const invested = asset.amount * asset.buyPrice;
        const current = asset.amount * asset.currentPrice;
        const pnl = current - invested;
        const pnlPercent = (pnl / invested) * 100;

        totalInvested += invested;
        currentTotal += current;

        return { ...asset, invested, current, pnl, pnlPercent };
    });

    const totalPnl = currentTotal - totalInvested;
    const totalPnlPercent = (totalPnl / totalInvested) * 100;

    res.status(200).json({
        totalInvested,
        currentTotal,
        totalPnl,
        totalPnlPercent,
        assets: detailedAssets
    });
}
