"""Aviso de apertura fuera de las Bandas de Bollinger.

A las 9:30 de Nueva York, cuando el precio abre por encima de la banda superior o
por debajo de la inferior, el movimiento suele venir con fuerza. Interesa solo
cuando ocurre a la vez en M15, 1H y D1: coincidir en las tres descarta el ruido
de una sola temporalidad.

El aviso se emite una vez por activo y día, en cuanto la vela de apertura tiene
precio, y se consulta desde el navegador para mostrarlo como notificación.
"""
import statistics
from datetime import datetime

from .saltos import MARKET_TZ

BB_PERIOD = 20
BB_MULT = 2.0

# Se evalúan de mayor a menor y se corta en la primera que falla. El orden importa
# para la cuota: abrir fuera de las bandas DIARIAS es raro (menos del 1% de las
# aperturas), así que D1 descarta casi todos los activos con una sola petición,
# mientras que M15 lo cumple más de la mitad de las veces y apenas filtra.
TEMPORALIDADES = ("1d", "1h", "m15")
APERTURA_MIN = 9 * 60 + 30      # 9:30 ET, la campana
VENTANA_MIN = 30                # hasta las 10:00 se sigue consultando por si el
                                # dato del proveedor llega con retraso

# Separación mínima de la banda para que el aviso valga la pena. Sin umbral, una
# apertura que supera la banda por milésimas cuenta igual que una que se va un 4%:
# en el gráfico la primera es indistinguible de un empate. Medido sobre 250
# aperturas reales, 0.25% deja las que se ven a simple vista.
SEPARACION_MIN_PCT = 0.25

# Minutos que abarca cada vela, para saber cuál contiene la campana de las 9:30
DURACION_MIN = {"m2": 2, "m3": 3, "m5": 5, "m10": 10, "m15": 15, "m30": 30, "1h": 60}


def _bandas(closes):
    """Banda superior e inferior de la ÚLTIMA vela cerrada antes de la apertura."""
    if len(closes) < BB_PERIOD:
        return None, None
    chunk = closes[-BB_PERIOD:]
    mid = sum(chunk) / BB_PERIOD
    sd = statistics.pstdev(chunk)
    return mid + BB_MULT * sd, mid - BB_MULT * sd


def _minutos(ts):
    """Minutos desde medianoche de un epoch 'naive' en hora de mercado."""
    dt = datetime.utcfromtimestamp(ts)
    return dt.hour * 60 + dt.minute


def _dia(ts):
    dt = datetime.utcfromtimestamp(ts)
    return dt.year * 10000 + dt.month * 100 + dt.day


def evaluar_apertura(candles, interval, hoy):
    """¿La apertura de hoy quedó fuera de las bandas en esta temporalidad?

    Las bandas se calculan con las velas ANTERIORES a la apertura, que es como
    se ven en el gráfico en el momento de abrir. Devuelve dict o None.
    """
    if not candles or len(candles) < BB_PERIOD + 1:
        return None

    # vela de apertura de hoy: en intradía la de las 9:30, en diario la del día
    if interval == "1d":
        # se busca la vela del día pedido, no solo la última: así el detector
        # puede evaluarse también sobre días pasados
        apertura = previas = None
        for i, c in enumerate(candles):
            if _dia(c["time"]) == hoy:
                apertura, previas = c, candles[:i]
                break
    else:
        # La PRIMERA vela de la sesión de hoy, la que contiene la campana. En M15
        # arranca a las 9:30; en 1H la vela va alineada a la hora en punto (09:00,
        # como en TC2000), así que la de la apertura es la que cubre las 9:30.
        # Cualquier vela posterior ya es la sesión en marcha, no la apertura.
        apertura = previas = None
        for i, c in enumerate(candles):
            if _dia(c["time"]) != hoy:
                continue
            fin = _minutos(c["time"]) + DURACION_MIN.get(interval, 15)
            if fin <= APERTURA_MIN:
                continue  # vela de premarket, aún no ha sonado la campana
            apertura, previas = c, candles[:i]
            break
    if not apertura or not previas or len(previas) < BB_PERIOD:
        return None

    sup, inf = _bandas([c["close"] for c in previas])
    if sup is None:
        return None

    precio = apertura["open"]
    if precio > sup:
        lado = "alcista"
        banda = sup
    elif precio < inf:
        lado = "bajista"
        banda = inf
    else:
        return None

    distancia = abs(precio / banda - 1) * 100
    if distancia < SEPARACION_MIN_PCT:
        return None  # roza la banda: no es un salto, es un empate

    return {
        "tf": interval,
        "direccion": lado,
        "apertura": round(precio, 4),
        "banda": round(banda, 4),
        "distancia_pct": round(distancia, 2),
    }


def en_ventana_apertura(ahora=None):
    """¿Estamos en la franja en que tiene sentido evaluar la apertura?"""
    n = ahora or datetime.now(MARKET_TZ)
    if n.weekday() >= 5:
        return False
    m = n.hour * 60 + n.minute
    return APERTURA_MIN <= m <= APERTURA_MIN + VENTANA_MIN
