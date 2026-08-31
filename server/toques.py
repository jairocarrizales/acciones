"""Escáner de rebotes del precio en las medias móviles.

Un REBOTE es la secuencia completa que se ve en el gráfico: el precio viene de
lejos, se acerca a una media, la toca sin perderla y se aleja de nuevo en la
dirección de la tendencia. Se exigen las cuatro fases, porque cualquiera por
separado produce señales falsas:

  1. APROXIMACIÓN  el precio venía separado de la media (no lleva pegado a ella)
  2. TOQUE         la vela alcanza la media con su mínimo (alcista) o máximo (bajista)
  3. RESPETO       el cierre queda del lado de la tendencia; si la pierde, no vale
  4. IMPULSO       velas posteriores rompen el extremo del toque y se alejan

La tendencia la marca el orden de las medias, nunca la vela suelta: así un cierre
al lado contrario invalida el rebote en vez de cambiarle el signo.

Se vigilan las medias de 20, 40, 100 y 200 en cada temporalidad. Rebotar en la 200
no es lo mismo que rebotar en la 20, así que cada rebote lleva la media donde
ocurrió y una calidad que combina el orden de las medias con la limpieza del giro.

CRUCES: además se detecta el cruce de la 20 con la 40, y de la 100 con la 200,
informando de cuántas velas hace que ocurrió.
"""

PERIODOS = (20, 40, 100, 200)

TOUCH_WINDOW = 100       # velas en las que se buscan rebotes (~3 semanas en 1H)
BREAK_LOOKAHEAD = 10     # velas siguientes en las que se admite la ruptura
CROSS_LOOKBACK = 40      # velas hacia atrás para considerar un cruce "reciente"

APPROACH_LOOKBACK = 6    # velas previas que se miran para exigir la aproximación
APPROACH_MIN_PCT = 0.45  # % mínimo de separación previa: filtra el precio pegado
IMPULSE_MIN_PCT = 0.55   # % mínimo que debe alejarse después para contar como rebote
TOUCH_TOLERANCE = 0.0015 # 0.15%: roce que cuenta como toque aunque no llegue a cruzar


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
    return {p: sma(closes, p) for p in PERIODOS}


def _orden(ma, i, alcista):
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


def _toca(candle, valor, alcista):
    """¿La vela alcanza la media? Se admite un roce muy cercano sin cruzarla."""
    margen = valor * TOUCH_TOLERANCE
    if alcista:
        return candle["low"] <= valor + margen
    return candle["high"] >= valor - margen


def _venia_separado(candles, ma_vals, i, alcista):
    """Fase 1: el precio estaba lejos de la media antes de acercarse."""
    mejor = 0.0
    for j in range(max(0, i - APPROACH_LOOKBACK), i):
        v = ma_vals[j]
        if v is None:
            continue
        # separación de la vela previa respecto de la media, del lado de la tendencia
        dist = (candles[j]["low"] - v) / v if alcista else (v - candles[j]["high"]) / v
        mejor = max(mejor, dist * 100)
    return mejor >= APPROACH_MIN_PCT


def _impulso(candles, ma_vals, i, alcista):
    """Fase 4: tras el toque el precio rompe el extremo y se aleja de la media.

    Devuelve el % máximo que llegó a alejarse, o None si nunca rompió.
    """
    c = candles[i]
    roto = False
    alejamiento = 0.0
    for j in range(i + 1, min(len(candles), i + 1 + BREAK_LOOKAHEAD)):
        k = candles[j]
        if alcista and k["high"] > c["high"]:
            roto = True
        if not alcista and k["low"] < c["low"]:
            roto = True
        if not roto:
            continue
        v = ma_vals[j]
        if v is None:
            continue
        dist = (k["high"] - v) / v if alcista else (v - k["low"]) / v
        alejamiento = max(alejamiento, dist * 100)
    return alejamiento if roto else None


def _agrupar(rebotes, separacion=4):
    """Funde los rebotes contiguos en la misma media, quedándose con el mejor.

    Dos velas seguidas que tocan la misma media son el mismo rebote visto dos
    veces; contarlas por separado inflaría el total sin añadir información.
    """
    salida = []
    for r in sorted(rebotes, key=lambda x: -x["velas_atras"]):  # del más antiguo al más nuevo
        previo = next((p for p in reversed(salida)
                       if p["media"] == r["media"]
                       and p["velas_atras"] - r["velas_atras"] <= separacion), None)
        if previo is None:
            salida.append(r)
        elif r["impulso_pct"] > previo["impulso_pct"]:
            previo.update(r)  # el mismo rebote, pero con su mejor lectura
    return salida


def detectar_rebotes(candles):
    """Rebotes válidos en cualquiera de las medias, dentro de la ventana reciente."""
    n = len(candles)
    if n < 210:
        return None
    ma = _medias(candles)
    desde = max(200, n - TOUCH_WINDOW)
    rebotes = []

    for i in range(desde, n):
        # dirección según el orden de las medias
        orden = _orden(ma, i, True)
        alcista = orden is not None
        if not alcista:
            orden = _orden(ma, i, False)
            if orden is None:
                continue

        c = candles[i]
        for periodo in PERIODOS:
            vals = ma[periodo]
            v = vals[i]
            if v is None or not _toca(c, v, alcista):
                continue
            # fase 3: el cierre respeta la media
            if alcista and c["close"] <= v:
                continue
            if not alcista and c["close"] >= v:
                continue
            # fase 1: venía separado, no arrastrándose por la media
            if not _venia_separado(candles, vals, i, alcista):
                continue
            # fase 4: rompe y se aleja lo suficiente
            alej = _impulso(candles, vals, i, alcista)
            if alej is None or alej < IMPULSE_MIN_PCT:
                continue

            # un rebote es "excelente" si además de las medias ordenadas el giro
            # fue amplio; si no, cuenta como bueno
            limpio = orden == "excelente" and alej >= IMPULSE_MIN_PCT * 2
            rebotes.append({
                "time": c["time"],
                "media": periodo,
                "price": round(v, 4),
                "direccion": "alcista" if alcista else "bajista",
                "orden": orden,
                "calidad": "excelente" if limpio else "bueno",
                "impulso_pct": round(alej, 2),
                "velas_atras": n - 1 - i,
            })

    # Velas consecutivas sobre la misma media son el MISMO rebote visto dos veces:
    # se conserva solo el de mayor impulso, para que la lista no lo cuente repetido.
    rebotes = _agrupar(rebotes)
    if not rebotes:
        return None
    excelentes = sum(1 for r in rebotes if r["calidad"] == "excelente")
    ultimo = rebotes[-1]
    por_media = {}
    for r in rebotes:
        por_media[r["media"]] = por_media.get(r["media"], 0) + 1
    return {
        "total": len(rebotes),
        "excelentes": excelentes,
        "buenos": len(rebotes) - excelentes,
        "direccion": ultimo["direccion"],
        "calidad": "excelente" if excelentes else "bueno",
        "ultimo_velas_atras": ultimo["velas_atras"],
        "ultima_media": ultimo["media"],
        "por_media": por_media,
        "rebotes": rebotes[-12:],
    }


# nombre anterior, conservado para no romper las llamadas existentes
detectar_toques = detectar_rebotes


# ---- Segundo toque en la MA20 (1H) ----
# El caso que se busca: la tendencia es alcista, el precio ya rebotó en la MA20
# sin perderla, y AHORA vuelve a tocarla. Ese segundo apoyo es la entrada.

SEGUNDO_VENTANA = 40   # velas 1H en las que deben caber los dos toques (~1 semana)
SEGUNDO_FRESCO = 2     # el toque actual no puede tener más de estas velas


def segundo_toque(candles, periodo=20):
    """Detecta que el precio está tocando AHORA la media, habiendo rebotado antes.

    Devuelve None si no está en esa situación. Si lo está, informa de cuántos
    apoyos previos confirmados hay y hace cuánto fue el anterior.
    """
    n = len(candles)
    if n < 210:
        return None
    ma = _medias(candles)
    vals = ma[periodo]

    # 1) ¿la vela actual (o la anterior) está tocando la media, respetándola?
    tocando = None
    for i in range(n - 1, max(n - 2 - SEGUNDO_FRESCO, 200), -1):
        v = vals[i]
        if v is None:
            continue
        orden = _orden(ma, i, True)
        alcista = orden is not None
        if not alcista:
            orden = _orden(ma, i, False)
            if orden is None:
                continue
        c = candles[i]
        if not _toca(c, v, alcista):
            continue
        # el cierre no puede perder la media: en compra, por encima
        if alcista and c["close"] <= v:
            continue
        if not alcista and c["close"] >= v:
            continue
        tocando = {"i": i, "alcista": alcista, "orden": orden, "valor": v}
        break
    if tocando is None:
        return None

    # 2) apoyos anteriores ya confirmados en la misma media y misma dirección
    previos = []
    desde = max(200, tocando["i"] - SEGUNDO_VENTANA)
    for i in range(desde, tocando["i"]):
        v = vals[i]
        if v is None:
            continue
        orden = _orden(ma, i, tocando["alcista"])
        if orden is None:
            continue
        c = candles[i]
        if not _toca(c, v, tocando["alcista"]):
            continue
        if tocando["alcista"] and c["close"] <= v:
            continue
        if not tocando["alcista"] and c["close"] >= v:
            continue
        if not _venia_separado(candles, vals, i, tocando["alcista"]):
            continue
        alej = _impulso(candles, vals, i, tocando["alcista"])
        if alej is None or alej < IMPULSE_MIN_PCT:
            continue
        previos.append({"velas_atras": n - 1 - i, "impulso_pct": round(alej, 2)})

    previos = _agrupar([{**p, "media": periodo} for p in previos])
    if not previos:
        return None   # es el primer toque, todavía no hay secuencia

    return {
        "media": periodo,
        "direccion": "alcista" if tocando["alcista"] else "bajista",
        "orden": tocando["orden"],
        "precio_ma": round(tocando["valor"], 4),
        "velas_atras": n - 1 - tocando["i"],
        # nº de apoyo: con un rebote previo, el actual es el segundo
        "numero": len(previos) + 1,
        "previo_velas_atras": min(p["velas_atras"] for p in previos),
        "time": candles[tocando["i"]]["time"],
    }


def estado_tendencia(candles):
    """Estado de la última vela para la rejilla: 'up', 'down' o 'flat'."""
    if not candles or len(candles) < 210:
        return None
    ma = _medias(candles)
    i = len(candles) - 1
    if _orden(ma, i, True):
        return "up"
    if _orden(ma, i, False):
        return "down"
    return "flat"


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
    ultimos = {}
    for c in fuera:
        if c["par"] not in ultimos or c["velas_atras"] < ultimos[c["par"]]["velas_atras"]:
            ultimos[c["par"]] = c
    return sorted(ultimos.values(), key=lambda c: c["velas_atras"])
