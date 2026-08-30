"""Escáner de toques a la media de 20 y de cruces de medias.

TOQUES (1H): la tendencia la marca el orden de las medias, no la vela. En
tendencia alcista una vela "toca" la MA20 cuando su mínimo la alcanza y CIERRA
por encima de ella; si cierra por debajo el toque queda invalidado. En bajista
es al revés: el máximo alcanza la media y el cierre queda por encima.
El toque solo cuenta como válido si, además, una vela posterior ROMPE el extremo
de la vela del toque: en alcista supera su máximo; en bajista pierde su mínimo.

Calidad del toque según el orden de las medias en ese momento:
    excelente -> 20 > 40 > 100 > 200  (alcista) o el inverso (bajista)
    bueno     -> 20 > 40 > 200        (sin exigir la 100 en su sitio)

CRUCES: se detecta el cruce de la 20 con la 40, y el de la 100 con la 200, en las
temporalidades pedidas, informando de cuántas velas hace que ocurrió.
"""

TOUCH_WINDOW = 100      # velas de 1H en las que se buscan toques (~3 semanas)
BREAK_LOOKAHEAD = 10    # velas siguientes en las que se admite la ruptura
CROSS_LOOKBACK = 40     # velas hacia atrás para considerar un cruce "reciente"


def sma(values, period):
    out = [None] * len(values)
    s = 0.0
    for i, v in enumerate(values):
        s += v
        if i >= period:
            s -= values[i - period]
        if i >= period - 1:
            out[i] = s / period
    return out


def _medias(candles):
    closes = [c["close"] for c in candles]
    return {p: sma(closes, p) for p in (20, 40, 100, 200)}


def _calidad(ma, i, alcista):
    """Orden de las medias en la vela i: 'excelente', 'bueno' o None."""
    v20, v40, v100, v200 = ma[20][i], ma[40][i], ma[100][i], ma[200][i]
    if None in (v20, v40, v200):
        return None
    if alcista:
        if v100 is not None and v20 > v40 > v100 > v200:
            return "excelente"
        return "bueno" if v20 > v40 > v200 else None
    if v100 is not None and v20 < v40 < v100 < v200:
        return "excelente"
    return "bueno" if v20 < v40 < v200 else None


def detectar_toques(candles):
    """Toques válidos a la MA20 en la ventana reciente."""
    n = len(candles)
    if n < 210:
        return None
    ma = _medias(candles)
    desde = max(200, n - TOUCH_WINDOW)
    toques = []

    for i in range(desde, n):
        v20 = ma[20][i]
        if v20 is None:
            continue
        c = candles[i]
        # La tendencia la define el orden de las medias, no la vela: así un
        # cierre al lado contrario invalida el toque en vez de cambiarle el signo.
        calidad = _calidad(ma, i, True)
        alcista = calidad is not None
        if not alcista:
            calidad = _calidad(ma, i, False)
            if calidad is None:
                continue

        # Toque: el rango de la vela alcanza la media y el cierre queda del lado
        # de la tendencia. Si cierra al otro lado, el toque no cuenta.
        if alcista:
            if not (c["low"] <= v20 and c["close"] > v20):
                continue
        else:
            if not (c["high"] >= v20 and c["close"] < v20):
                continue

        # Validación: una vela posterior rompe el extremo de la vela del toque.
        roto = False
        for j in range(i + 1, min(n, i + 1 + BREAK_LOOKAHEAD)):
            if alcista and candles[j]["high"] > c["high"]:
                roto = True
                break
            if not alcista and candles[j]["low"] < c["low"]:
                roto = True
                break
        if not roto:
            continue

        toques.append({
            "time": c["time"],
            "price": round(v20, 4),
            "direccion": "alcista" if alcista else "bajista",
            "calidad": calidad,
            "velas_atras": n - 1 - i,
        })

    if not toques:
        return None
    excelentes = sum(1 for t in toques if t["calidad"] == "excelente")
    ultimo = toques[-1]
    return {
        "total": len(toques),
        "excelentes": excelentes,
        "buenos": len(toques) - excelentes,
        "direccion": ultimo["direccion"],
        "calidad": "excelente" if excelentes else "bueno",
        "ultimo_velas_atras": ultimo["velas_atras"],
        "toques": toques[-12:],
    }


def detectar_cruces(candles, pares=((20, 40), (100, 200))):
    """Cruces recientes entre pares de medias, con su antigüedad en velas."""
    n = len(candles)
    if n < 210:
        return []
    ma = _medias(candles)
    fuera = []
    for corta, larga in pares:
        a, b = ma[corta], ma[larga]
        for i in range(max(0, n - CROSS_LOOKBACK), n):
            if None in (a[i], b[i], a[i - 1], b[i - 1]):
                continue
            antes, ahora = a[i - 1] - b[i - 1], a[i] - b[i]
            if antes <= 0 < ahora or antes >= 0 > ahora:
                fuera.append({
                    "par": f"{corta}/{larga}",
                    "direccion": "alcista" if ahora > 0 else "bajista",
                    "velas_atras": n - 1 - i,
                    "time": candles[i]["time"],
                })
    # el más reciente de cada par
    ultimos = {}
    for c in fuera:
        if c["par"] not in ultimos or c["velas_atras"] < ultimos[c["par"]]["velas_atras"]:
            ultimos[c["par"]] = c
    return sorted(ultimos.values(), key=lambda c: c["velas_atras"])
