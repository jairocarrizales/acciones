"""Datos de sesión pre-market / post-market vía la API pública de gráficos de Yahoo Finance
(sin necesidad de API key; usada por muchas apps de finanzas para este mismo propósito).
"""
import time

import httpx

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


class MarketDataError(Exception):
    pass


async def fetch_session_quote(symbol: str) -> dict:
    params = {"interval": "1m", "range": "1d", "includePrePost": "true"}
    async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
        r = await client.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}", params=params)
    data = r.json()
    result = (data.get("chart") or {}).get("result")
    if not result:
        err = (data.get("chart") or {}).get("error") or {}
        raise MarketDataError(err.get("description", "Sin datos de Yahoo Finance"))

    meta = result[0]["meta"]
    timestamps = result[0].get("timestamp") or []
    quote = result[0].get("indicators", {}).get("quote", [{}])[0]
    closes = quote.get("close") or []

    prev_close = meta.get("previousClose") or meta.get("chartPreviousClose")
    periods = meta.get("currentTradingPeriod", {})
    now = time.time()

    session = "closed"
    for name in ("pre", "regular", "post"):
        p = periods.get(name)
        if p and p["start"] <= now < p["end"]:
            session = {"pre": "premarket", "regular": "regular", "post": "postmarket"}[name]
            break

    last_price, last_ts = None, None
    for ts, c in zip(reversed(timestamps), reversed(closes)):
        if c is not None:
            last_price, last_ts = c, ts
            break

    if last_price is None or prev_close is None:
        raise MarketDataError("Datos incompletos")

    change = last_price - prev_close
    change_pct = (change / prev_close * 100) if prev_close else 0

    return {
        "session": session,
        "price": round(last_price, 4),
        "change": round(change, 4),
        "change_pct": round(change_pct, 4),
        "previous_close": round(prev_close, 4),
        "last_ts": last_ts,
    }
