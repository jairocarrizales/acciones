"""Escáner de consolidaciones largas en H1.

Busca activos que llevan diez días o más moviéndose en un rango horizontal, que es
donde se preparan las rupturas grandes. El escáner de saltos también detecta
consolidaciones, pero en M15 y con una ventana de dos horas pensada para el
premarket: aquí interesa la foto de semanas.

Se comprueban cuatro cosas sobre la ventana, y las cuatro tienen que cumplirse:

  1. RANGO HORIZONTAL  los máximos entre sí, y los mínimos entre sí, apenas se
     desvían: hay un techo y un suelo reconocibles.
  2. MEDIAS LARGAS JUNTAS  la 100 y la 200 pegadas, señal de que no hay tendencia
     de fondo que empuje al precio.
  3. MEDIAS CORTAS PLANAS  la 20 y la 40 sin apenas pendiente en el periodo.
  4. BOLLINGER ESTRECHO  el ancho de las bandas comprimido respecto a su propia
     media, el "squeeze" que suele preceder a la ruptura.

Sobre el punto 2: la idea original era contar cuántas veces se cruzan la 100 y la
200, porque en lateral se enredan. Medido sobre 53 activos, en H1 esas medias son
demasiado lentas para eso: el máximo son DOS cruces en treinta días y en diez días
casi todos dan cero o uno, así que contarlos no separa consolidación de tendencia.
Lo que sí discrimina es cuánto distan entre sí, de 0.29% cuando están enredadas a
más del 4% con tendencia clara. El conteo se conserva como dato informativo en la
ficha, pero no filtra.
"""

# Diez días de mercado en H1: siete velas por sesión (9:00-15:00) por diez días.
VENTANA_VELAS = 70
EXTREMOS = 8          # cuántos máximos y mínimos se miran para definir el rango
SQUEEZE_PASO = 5      # cada cuántas velas se muestrea el ancho de banda histórico
BB_PERIOD = 20

# Umbrales por nivel de exigencia, sacados de medir los 53 activos de la lista:
#   (dispersión de extremos, separación 100/200, pendiente 20 y 40, squeeze)
NIVELES = {
    "suave":    (2.0, 4.0, 6.0, 1.3),
    "medio":    (1.2, 2.0, 3.0, 1.0),
    "estricto": (0.9, 1.5, 1.5, 0.8),
}

# Velas H1 por sesión, para traducir la ventana a días de mercado
VELAS_POR_DIA = 7


def _pstdev(valores):
    """Desviación típica poblacional, como la que usan las Bandas de Bollinger."""
    n = len(valores)
    if n < 2:
        return 0.0
    media = sum(valores) / n
    return (sum((v - media) ** 2 for v in valores) / n) ** 0.5


def _ancho_banda(candles, i):
    """Ancho de las Bandas de Bollinger en la vela i, en % del precio."""
    if i < BB_PERIOD - 1:
        return None
    trozo = [c["close"] for c in candles[i - BB_PERIOD + 1:i + 1]]
    media = sum(trozo) / BB_PERIOD
    if not media:
        return None
    return 4 * _pstdev(trozo) / media * 100  # 4 = dos desviaciones a cada lado


def _pendiente(vals, desde, hasta):
    """Variación porcentual de una media entre dos posiciones."""
    a, b = vals[desde], vals[hasta]
    if a is None or b is None or not a:
        return None
    return abs((b - a) / a * 100)


def detectar(candles, medias, nivel="medio"):
    """¿El activo lleva la ventana entera consolidando? Devuelve dict o None.

    `medias` es el dict {periodo: lista} que ya calcula el módulo de toques, para
    no repetir el cálculo.
    """
    n = len(candles)
    if n < VENTANA_VELAS + 210:
        return None
    disp_max, sep_max, pend_max, squeeze_max = NIVELES.get(nivel, NIVELES["medio"])

    ini = n - VENTANA_VELAS
    ventana = candles[ini:]

    # 1) rango horizontal: los extremos deben agruparse, no dispersarse
    altos = sorted((c["high"] for c in ventana), reverse=True)[:EXTREMOS]
    bajos = sorted(c["low"] for c in ventana)[:EXTREMOS]
    if not altos or not bajos or not altos[0] or not bajos[0]:
        return None
    disp_techo = (altos[0] - altos[-1]) / altos[0] * 100
    disp_suelo = (bajos[-1] - bajos[0]) / bajos[0] * 100
    if disp_techo > disp_max or disp_suelo > disp_max:
        return None

    # 2) la 100 y la 200, pegadas: sin tendencia de fondo
    seps = [abs(medias[100][i] - medias[200][i]) / medias[200][i] * 100
            for i in range(ini, n)
            if medias[100][i] is not None and medias[200][i]]
    if not seps:
        return None
    separacion = sum(seps) / len(seps)
    if separacion > sep_max:
        return None

    # 3) la 20 y la 40, planas
    pend20 = _pendiente(medias[20], ini, n - 1)
    pend40 = _pendiente(medias[40], ini, n - 1)
    if pend20 is None or pend40 is None:
        return None
    if pend20 > pend_max or pend40 > pend_max:
        return None

    # 4) Bollinger comprimido respecto a su propia media en la ventana
    ahora = _ancho_banda(candles, n - 1)
    muestras = [a for a in (_ancho_banda(candles, i)
                            for i in range(ini, n, SQUEEZE_PASO)) if a]
    if ahora is None or not muestras:
        return None
    medio = sum(muestras) / len(muestras)
    squeeze = ahora / medio if medio else None
    if squeeze is None or squeeze > squeeze_max:
        return None

    # dato informativo: cuántas veces se cruzaron la 100 y la 200 (no filtra)
    cruces = 0
    for i in range(ini, n):
        a, b = medias[100], medias[200]
        if None in (a[i], b[i], a[i - 1], b[i - 1]):
            continue
        if (a[i - 1] - b[i - 1]) * (a[i] - b[i]) < 0:
            cruces += 1

    techo = max(c["high"] for c in ventana)
    suelo = min(c["low"] for c in ventana)
    ultimo = ventana[-1]["close"]
    alto = techo - suelo

    return {
        "techo": round(techo, 4),
        "suelo": round(suelo, 4),
        # extremos temporales de la ventana, para poder dibujar el rango
        "desde": ventana[0]["time"],
        "hasta": ventana[-1]["time"],
        "ancho_pct": round(alto / ultimo * 100, 2),
        # dónde está el precio dentro del rango: cerca de 100 es pegado al techo
        "posicion_pct": round((ultimo - suelo) / alto * 100, 1) if alto else None,
        "ultimo": round(ultimo, 4),
        "dias": round(VENTANA_VELAS / VELAS_POR_DIA),
        "separacion_100_200": round(separacion, 2),
        "pendiente_20": round(pend20, 2),
        "pendiente_40": round(pend40, 2),
        "squeeze": round(squeeze, 2),
        "cruces_100_200": cruces,
        "disp_techo": round(disp_techo, 2),
        "disp_suelo": round(disp_suelo, 2),
    }


def evaluar_ruptura(rango, precio):
    """¿El precio ha salido del rango consolidado? None si sigue dentro."""
    if not rango or not precio:
        return None
    if precio > rango["techo"]:
        return {"lado": "alza",
                "exceso_pct": round((precio / rango["techo"] - 1) * 100, 2)}
    if precio < rango["suelo"]:
        return {"lado": "baja",
                "exceso_pct": round((1 - precio / rango["suelo"]) * 100, 2)}
    return None
