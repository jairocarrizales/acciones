"""Escáner de "saltos": detecta consolidación (Bandas de Bollinger M15 casi
horizontales) durante el premarket y, a las 9:30:05 ET, evalúa qué candidatos
abrieron fuera del rango consolidado (gap) para operar la reversión:
salto a la baja -> CALL, salto al alza -> PUT.

Datos: API pública de gráficos de Yahoo Finance (incluye premarket, sin API key).
"""
import statistics
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

MARKET_TZ = ZoneInfo("America/New_York")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

BB_PERIOD = 20
BB_MULT = 2.0
WINDOW = 8              # velas M15 = 2 horas de consolidación
MIN_WINDOW_CANDLES = 5  # el premarket puede tener huecos en símbolos poco líquidos
FLAT_MAX_DRIFT_PCT = 0.5  # deriva máxima de cada banda dentro de la ventana, en % del precio
JUMP_MULT = 1.0         # salto mínimo = 1x el tamaño del rango consolidado


class SaltosError(Exception):
    pass


async def _fetch_chart(client, symbol, interval, rng):
    params = {"interval": interval, "range": rng, "includePrePost": "true"}
    r = await client.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}", params=params)
    data = r.json()
    result = (data.get("chart") or {}).get("result")
    if not result:
        err = (data.get("chart") or {}).get("error") or {}
        raise SaltosError(err.get("description", "Sin datos de Yahoo Finance"))
    timestamps = result[0].get("timestamp") or []
    quote = result[0].get("indicators", {}).get("quote", [{}])[0]
    candles = []
    for i, ts in enumerate(timestamps):
        o, h, l, c = (quote.get(k, [None] * len(timestamps))[i] for k in ("open", "high", "low", "close"))
        if None in (o, h, l, c):
            continue
        candles.append({"ts": ts, "open": o, "high": h, "low": l, "close": c})
    return candles


def _bollinger(closes):
    """Listas (upper, lower) alineadas con closes; None donde no hay histórico."""
    upper, lower = [None] * len(closes), [None] * len(closes)
    for i in range(BB_PERIOD - 1, len(closes)):
        chunk = closes[i - BB_PERIOD + 1: i + 1]
        mid = sum(chunk) / BB_PERIOD
        sd = statistics.pstdev(chunk)
        upper[i] = mid + BB_MULT * sd
        lower[i] = mid - BB_MULT * sd
    return upper, lower


def detect_consolidation(candles, cutoff_ts=None):
    """Evalúa si las últimas WINDOW velas M15 (antes de cutoff_ts, si se da) están
    consolidadas: ambas bandas casi horizontales. Devuelve dict o None."""
    if cutoff_ts is not None:
        candles = [c for c in candles if c["ts"] < cutoff_ts]
    if len(candles) < BB_PERIOD + 1:
        return None
    closes = [c["close"] for c in candles]
    upper, lower = _bollinger(closes)

    win = list(range(max(BB_PERIOD - 1, len(candles) - WINDOW), len(candles)))
    win = [i for i in win if upper[i] is not None]
    if len(win) < MIN_WINDOW_CANDLES:
        return None

    last_close = closes[-1]
    if last_close <= 0:
        return None
    up_vals = [upper[i] for i in win]
    lo_vals = [lower[i] for i in win]
    drift_up = (max(up_vals) - min(up_vals)) / last_close * 100
    drift_lo = (max(lo_vals) - min(lo_vals)) / last_close * 100
    if drift_up > FLAT_MAX_DRIFT_PCT or drift_lo > FLAT_MAX_DRIFT_PCT:
        return None

    # Rango consolidado: extremos de velas Y de las bandas (lo que sea mayor/menor).
    range_high = max(max(candles[i]["high"] for i in win), max(up_vals))
    range_low = min(min(candles[i]["low"] for i in win), min(lo_vals))
    range_size = range_high - range_low
    if range_size <= 0:
        return None

    return {
        "range_high": round(range_high, 4),
        "range_low": round(range_low, 4),
        "range_size": round(range_size, 4),
        "last_close": round(last_close, 4),
        "window_candles": len(win),
        "drift_up_pct": round(drift_up, 3),
        "drift_lo_pct": round(drift_lo, 3),
    }


async def scan_symbol(client, symbol, cutoff_ts=None):
    """Consolidación de un símbolo (o None si no está consolidado / sin datos)."""
    try:
        candles = await _fetch_chart(client, symbol, "15m", "5d")
    except (SaltosError, httpx.HTTPError):
        return None
    return detect_consolidation(candles, cutoff_ts)


async def fetch_open_930(client, symbol):
    """Precio de apertura de la vela de 1 min de las 9:30 ET de hoy (o None si aún no existe)."""
    try:
        candles = await _fetch_chart(client, symbol, "1m", "1d")
    except (SaltosError, httpx.HTTPError):
        return None
    today = datetime.now(MARKET_TZ).date()
    for c in candles:
        dt = datetime.fromtimestamp(c["ts"], MARKET_TZ)
        if dt.date() == today and dt.hour == 9 and dt.minute == 30:
            return c["open"]
    return None


async def fetch_last_price(client, symbol):
    """Último precio disponible (fallback si la vela de las 9:30 aún no aparece)."""
    try:
        candles = await _fetch_chart(client, symbol, "1m", "1d")
    except (SaltosError, httpx.HTTPError):
        return None
    return candles[-1]["close"] if candles else None


def judge_jump(candidate, open_price):
    """Clasifica el salto según el rango consolidado. Reversión: baja->CALL, alza->PUT."""
    rng = candidate["range_size"] * JUMP_MULT
    if open_price >= candidate["range_high"] + rng:
        return {"status": "salto_alza", "operation": "PUT",
                "jump": round(open_price - candidate["range_high"], 4)}
    if open_price <= candidate["range_low"] - rng:
        return {"status": "salto_baja", "operation": "CALL",
                "jump": round(candidate["range_low"] - open_price, 4)}
    return {"status": "sin_salto", "operation": None, "jump": 0}


def make_client():
    return httpx.AsyncClient(timeout=15, headers=HEADERS)
