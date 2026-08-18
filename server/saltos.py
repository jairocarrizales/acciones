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
FLAT_MAX_DRIFT_PCT = 0.6  # deriva máxima de cada banda dentro de la ventana, en % del precio
DEFAULT_JUMP_PCT = 50.0   # salto mínimo por defecto: 50% del rango consolidado (configurable en la UI)

# Filtro de "mercado lateral", recalibrado con datos de DOS días (22 y 23 jul 2026):
# se mide la deriva NETA de la banda media (SMA20) — dónde termina respecto a dónde
# empezó — que discrimina tendencia real mejor que el rango max-min (una tarde volátil
# pero que vuelve al mismo nivel no es tendencia). Umbrales holgados a propósito: es
# preferible un candidato de más (que simplemente no saltará) a perder un salto real.
TREND_WINDOW = 24         # velas M15 (~6 h: final de la sesión de ayer + premarket)
MID_NET_MAX_PCT = 0.45    # deriva NETA máxima de la banda media en TREND_WINDOW, % del precio
MAX_BANDWIDTH_PCT = 1.5   # ancho máximo (sup - inf) al final, % del precio


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
    """Listas (upper, mid, lower) alineadas con closes; None donde no hay histórico."""
    upper, mid_l, lower = [None] * len(closes), [None] * len(closes), [None] * len(closes)
    for i in range(BB_PERIOD - 1, len(closes)):
        chunk = closes[i - BB_PERIOD + 1: i + 1]
        mid = sum(chunk) / BB_PERIOD
        sd = statistics.pstdev(chunk)
        upper[i] = mid + BB_MULT * sd
        mid_l[i] = mid
        lower[i] = mid - BB_MULT * sd
    return upper, mid_l, lower


def detect_consolidation(candles, cutoff_ts=None):
    """Evalúa si las últimas WINDOW velas M15 (antes de cutoff_ts, si se da) están
    consolidadas: ambas bandas casi horizontales. Devuelve dict o None."""
    if cutoff_ts is not None:
        candles = [c for c in candles if c["ts"] < cutoff_ts]
    if len(candles) < BB_PERIOD + 1:
        return None
    closes = [c["close"] for c in candles]
    upper, mid, lower = _bollinger(closes)

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

    # Lateral de fondo: la banda media (SMA20) no debe TERMINAR lejos de donde empezó
    # en la ventana larga (deriva neta). Excluye símbolos en tendencia hacia la
    # apertura cuyo premarket inmediato luce plano pero no es consolidación real.
    trend_win = [i for i in range(max(BB_PERIOD - 1, len(candles) - TREND_WINDOW), len(candles))
                 if mid[i] is not None]
    if len(trend_win) < TREND_WINDOW // 2:
        return None
    mid_vals = [mid[i] for i in trend_win]
    drift_mid = abs(mid_vals[-1] - mid_vals[0]) / last_close * 100
    if drift_mid > MID_NET_MAX_PCT:
        return None

    # Volatilidad baja: bandas no demasiado separadas al momento del corte.
    bandwidth = (up_vals[-1] - lo_vals[-1]) / last_close * 100
    if bandwidth > MAX_BANDWIDTH_PCT:
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
        "drift_mid_pct": round(drift_mid, 3),
        "bandwidth_pct": round(bandwidth, 3),
    }


async def scan_symbol(client, symbol, cutoff_ts=None):
    """Consolidación de un símbolo (o None si no está consolidado / sin datos)."""
    try:
        candles = await _fetch_chart(client, symbol, "15m", "5d")
    except (SaltosError, httpx.HTTPError):
        return None
    return detect_consolidation(candles, cutoff_ts)


async def fetch_open_snapshot(client, symbol, until_minute=35):
    """Movimiento de apertura de hoy: apertura de la vela de las 9:30 y el máximo/mínimo
    de TODAS las velas de 1 min desde las 9:30 hasta las 9:until_minute (inclusive de
    las que van formándose). Se llama repetidamente durante la ventana de vigilancia,
    así el disparo se detecta tanto si ocurre en los primeros segundos como si se
    materializa en los minutos 2-4. None si la vela de las 9:30 aún no existe."""
    try:
        candles = await _fetch_chart(client, symbol, "1m", "1d")
    except (SaltosError, httpx.HTTPError):
        return None
    today = datetime.now(MARKET_TZ).date()
    open_price, hi, lo = None, None, None
    for c in candles:
        dt = datetime.fromtimestamp(c["ts"], MARKET_TZ)
        if dt.date() != today or dt.hour != 9 or dt.minute < 30 or dt.minute > until_minute:
            continue
        if dt.minute == 30:
            open_price = c["open"]
        hi = c["high"] if hi is None else max(hi, c["high"])
        lo = c["low"] if lo is None else min(lo, c["low"])
    if open_price is None:
        return None
    return {"open": open_price, "high": hi, "low": lo}


def pick_extreme(candidate, prices):
    """El precio que más se aleja del rango consolidado (0 si está dentro).
    Así el salto se mide sobre el movimiento real de la apertura, no solo el open."""
    def deviation(p):
        if p > candidate["range_high"]:
            return p - candidate["range_high"]
        if p < candidate["range_low"]:
            return candidate["range_low"] - p
        return 0.0
    return max(prices, key=deviation)


async def fetch_last_price(client, symbol):
    """Último precio disponible (fallback si la vela de las 9:30 aún no aparece)."""
    try:
        candles = await _fetch_chart(client, symbol, "1m", "1d")
    except (SaltosError, httpx.HTTPError):
        return None
    return candles[-1]["close"] if candles else None


def judge_jump(candidate, open_price, mult):
    """Clasifica el salto según el rango consolidado. Reversión: baja->CALL, alza->PUT.
    mult: fracción del rango que debe superar la apertura (0.5 = 50% del rango)."""
    rng = candidate["range_size"] * mult
    if open_price >= candidate["range_high"] + rng:
        return {"status": "salto_alza", "operation": "PUT",
                "jump": round(open_price - candidate["range_high"], 4)}
    if open_price <= candidate["range_low"] - rng:
        return {"status": "salto_baja", "operation": "CALL",
                "jump": round(candidate["range_low"] - open_price, 4)}
    return {"status": "sin_salto", "operation": None, "jump": 0}


def make_client():
    return httpx.AsyncClient(timeout=15, headers=HEADERS)
