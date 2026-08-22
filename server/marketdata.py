"""Datos de sesión pre-market / post-market vía la API pública de gráficos de Yahoo Finance
(sin necesidad de API key; usada por muchas apps de finanzas para este mismo propósito).
"""
import calendar
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
MARKET_TZ = ZoneInfo("America/New_York")

# Velas intradía con sesión extendida (pre 4:00 + regular + post hasta 20:00), como
# TC2000/TradingView con "ext" activado. Yahoo limita el histórico intradía: 15m/30m
# a 60 días y 1h a 730 días.
EXT_INTERVAL = {"m5": ("5m", "60d"), "m15": ("15m", "60d"), "1h": ("1h", "730d")}


class MarketDataError(Exception):
    pass


async def fetch_extended_candles(symbol: str, interval: str) -> list[dict]:
    """Velas OHLCV intradía con premarket y postmarket, en el mismo formato y convención
    horaria que la caché regular (epoch 'naive' de la hora de Nueva York)."""
    yi, rng = EXT_INTERVAL[interval]
    params = {"interval": yi, "range": rng, "includePrePost": "true"}
    async with httpx.AsyncClient(timeout=20, headers=HEADERS) as client:
        r = await client.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}", params=params)
    data = r.json()
    result = (data.get("chart") or {}).get("result")
    if not result:
        err = (data.get("chart") or {}).get("error") or {}
        raise MarketDataError(err.get("description", "Sin datos de Yahoo Finance"))
    timestamps = result[0].get("timestamp") or []
    q = result[0].get("indicators", {}).get("quote", [{}])[0]
    n = len(timestamps)
    opens, highs, lows, closes = (q.get(k) or [None] * n for k in ("open", "high", "low", "close"))
    vols = q.get("volume") or [None] * n
    rows = []
    for i, ts in enumerate(timestamps):
        o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        if None in (o, h, l, c):
            continue
        dt = datetime.fromtimestamp(ts, MARKET_TZ)
        naive = calendar.timegm((dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, 0, 0, 0))
        rows.append({"time": naive, "open": o, "high": h, "low": l, "close": c, "volume": vols[i] or 0})
    rows.sort(key=lambda x: x["time"])
    return _clean_bad_wicks(rows)


# En sesión extendida el feed público de Yahoo trae a veces operaciones aisladas
# (lotes impares fuera de mercado) que producen mechas absurdas de +-20 % en una vela;
# TC2000/TradingView las filtran. Se recorta cualquier mecha que se aleje del cuerpo
# más de MAX_WICK_PCT (el cuerpo open-close se conserva intacto).
MAX_WICK_PCT = 3.0


def _clean_bad_wicks(rows):
    for r in rows:
        body_hi, body_lo = max(r["open"], r["close"]), min(r["open"], r["close"])
        lim = body_hi * MAX_WICK_PCT / 100
        if r["high"] - body_hi > lim:
            r["high"] = body_hi
        if body_lo - r["low"] > lim:
            r["low"] = body_lo
    return rows


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
