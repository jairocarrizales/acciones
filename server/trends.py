"""Escáner de tendencia basado en medias móviles simples (SMA).

Para una temporalidad se calculan 4 "círculos":
  0: 20 vs 40      1: 40 vs 100      2: 100 vs 200
  3: resumen — verde solo si los 3 anteriores son alcistas, rojo si los 3 bajistas.

Cada círculo puede ser "up" (alcista), "down" (bajista) o "neutral"
(medias cruzadas / sin datos suficientes).

La tendencia SIEMPRE se evalúa sobre la última vela YA CERRADA: si la última
vela que devuelve el proveedor todavía se está formando (la sesión en curso),
se descarta, porque su precio en vivo distorsiona la SMA y da señales falsas.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

MA_PAIRS = [(20, 40), (40, 100), (100, 200)]

MARKET_TZ = ZoneInfo("America/New_York")
MARKET_CLOSE_HOUR = 16  # 16:00 ET, cierre de la sesión regular de acciones/ETFs de EE. UU.
INTRADAY_SECONDS = {"m2": 120, "m3": 180, "m5": 300, "m10": 600, "m15": 900, "1h": 3600, "4h": 14400}


def _last_closed_index(candles, interval):
    """Índice de la última vela ya cerrada (puede excluir la última si aún se forma)."""
    n = len(candles)
    if n == 0:
        return -1
    now = datetime.now(MARKET_TZ).replace(tzinfo=None)
    # Las velas se guardan como epoch de la hora local de mercado (ver twelvedata._parse_ts),
    # así que utcfromtimestamp devuelve directamente la hora de mercado de inicio de la vela.
    start = datetime.utcfromtimestamp(candles[-1]["time"])
    if interval == "1d":
        close_at = start.replace(hour=MARKET_CLOSE_HOUR, minute=0, second=0, microsecond=0)
    else:
        close_at = start + timedelta(seconds=INTRADAY_SECONDS.get(interval, 0))
    # Si la vela aún no ha cerrado, usamos la anterior.
    return n - 2 if now < close_at else n - 1


def _sma_last(closes, period):
    """SMA de `period` cierres terminando en el último de la lista, o None."""
    if len(closes) < period:
        return None
    return sum(closes[-period:]) / period


def compute_trend(candles, interval):
    """Devuelve una lista de 4 estados ('up'|'down'|'neutral') para la temporalidad."""
    idx = _last_closed_index(candles, interval)
    if idx < 0:
        return ["neutral", "neutral", "neutral", "neutral"]
    closes = [c["close"] for c in candles[: idx + 1] if c.get("close") is not None]
    circles = []
    for short_p, long_p in MA_PAIRS:
        s = _sma_last(closes, short_p)
        l = _sma_last(closes, long_p)
        if s is None or l is None:
            circles.append("neutral")
        elif s > l:
            circles.append("up")
        elif s < l:
            circles.append("down")
        else:
            circles.append("neutral")
    if all(c == "up" for c in circles):
        summary = "up"
    elif all(c == "down" for c in circles):
        summary = "down"
    else:
        summary = "neutral"
    circles.append(summary)
    return circles
