"""Escáner de tendencia basado en medias móviles simples (SMA).

Para una temporalidad se calculan 4 "círculos":
  0: 20 vs 40      1: 40 vs 100      2: 100 vs 200
  3: resumen — verde solo si los 3 anteriores son alcistas, rojo si los 3 bajistas.

Cada círculo puede ser "up" (alcista), "down" (bajista) o "neutral"
(medias cruzadas / sin datos suficientes).
"""

MA_PAIRS = [(20, 40), (40, 100), (100, 200)]


def _sma_last(closes, period):
    """Último valor de la SMA de `period` sobre la lista de cierres, o None."""
    if len(closes) < period:
        return None
    return sum(closes[-period:]) / period


def compute_trend(candles):
    """Devuelve una lista de 4 estados ('up'|'down'|'neutral') para la temporalidad."""
    closes = [c["close"] for c in candles if c.get("close") is not None]
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
