"""Cálculo de rango de precios a partir de la cadena de opciones (método Investep).

Para cada contrato del vencimiento elegido:
    RANGO      = STRIKE + PRECIO      (punto de equilibrio del contrato)
    PORCENTAJE = RANGO / precio_actual - 1

En calls el rango queda por encima del precio (movimiento alcista necesario para
llegar al equilibrio); en puts la referencia es STRIKE - PRECIO, es decir el
movimiento a la baja. Se guarda todo lo usado para poder auditarlo después.

Datos: cadena de opciones pública de Yahoo Finance (requiere cookie + crumb).
"""
import asyncio
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx

MARKET_TZ = ZoneInfo("America/New_York")
CDMX_TZ = ZoneInfo("America/Mexico_City")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
}


class RangosError(Exception):
    pass


_crumb_cache = {"crumb": None, "cookies": None, "ts": 0.0}


async def _client_with_crumb():
    """Cliente con la cookie y el crumb que Yahoo exige para la cadena de opciones."""
    client = httpx.AsyncClient(timeout=25, headers=HEADERS, follow_redirects=True)
    try:
        await client.get("https://fc.yahoo.com")
        r = await client.get("https://query1.finance.yahoo.com/v1/test/getcrumb")
        crumb = r.text.strip()
        if not crumb or "<" in crumb:
            raise RangosError("No se pudo autenticar contra Yahoo Finance")
        return client, crumb
    except httpx.HTTPError as e:
        await client.aclose()
        raise RangosError(f"Error de red con Yahoo Finance: {e}")


async def fetch_chain(symbol: str):
    """Cadena de opciones del vencimiento MÁS CERCANO (el que devuelve Yahoo por defecto)."""
    client, crumb = await _client_with_crumb()
    try:
        params = {"crumb": crumb}
        r = await client.get(
            f"https://query1.finance.yahoo.com/v7/finance/options/{symbol.upper()}",
            params=params,
        )
        data = r.json()
    except httpx.HTTPError as e:
        raise RangosError(f"Error de red con Yahoo Finance: {e}")
    finally:
        await client.aclose()

    err = (data.get("optionChain") or {}).get("error")
    result = (data.get("optionChain") or {}).get("result")
    if err or not result:
        msg = (err or {}).get("description") if isinstance(err, dict) else None
        raise RangosError(msg or f"Sin datos de opciones para {symbol.upper()}")
    return result[0]


def _row(contract, spot, kind):
    """Fila del cálculo para un contrato: strike, precio, rango y porcentaje."""
    strike = contract.get("strike")
    price = contract.get("lastPrice")
    if strike is None or price is None:
        return None
    # Call: equilibrio por encima (strike + prima). Put: por debajo (strike - prima).
    rango = strike + price if kind == "call" else strike - price
    pct = (rango / spot - 1) * 100 if spot else 0.0
    return {
        "strike": round(strike, 4),
        "price": round(price, 4),
        "range": round(rango, 4),
        "pct": round(pct, 3),
        "bid": contract.get("bid"),
        "ask": contract.get("ask"),
        "volume": contract.get("volume") or 0,
        "open_interest": contract.get("openInterest") or 0,
        "in_the_money": bool(contract.get("inTheMoney")),
    }


def build_calculation(chain, kind="call"):
    """Construye el cálculo completo a partir de una cadena de opciones."""
    quote = chain.get("quote") or {}
    spot = quote.get("regularMarketPrice")
    if not spot:
        raise RangosError("Sin precio actual del activo")

    options = (chain.get("options") or [{}])[0]
    contracts = options.get("calls" if kind == "call" else "puts") or []
    rows = [r for r in (_row(c, spot, kind) for c in contracts) if r]
    if not rows:
        raise RangosError("El vencimiento no tiene contratos con precio")
    rows.sort(key=lambda r: r["strike"])

    exp_ts = options.get("expirationDate")
    prev_close = quote.get("regularMarketPreviousClose")
    change_pct = quote.get("regularMarketChangePercent")
    # Dirección del día: sirve para saber si el movimiento fue alcista o bajista.
    if change_pct is None and prev_close:
        change_pct = (spot / prev_close - 1) * 100

    return {
        "symbol": (quote.get("symbol") or "").upper(),
        "kind": kind,
        "spot": round(spot, 4),
        "previous_close": round(prev_close, 4) if prev_close else None,
        "change_pct": round(change_pct, 3) if change_pct is not None else None,
        "direction": ("alcista" if (change_pct or 0) > 0 else
                      "bajista" if (change_pct or 0) < 0 else "neutro"),
        "expiration": datetime.fromtimestamp(exp_ts, timezone.utc).strftime("%Y-%m-%d") if exp_ts else None,
        "expiration_ts": exp_ts,
        "rows": rows,
    }


# ---------------- mejor momento para hacer el cálculo ----------------
# Las primas de las opciones solo son fiables cuando el mercado está abierto y hay
# volumen: al abrir (9:30-10:00 ET) los spreads son anchos y erráticos, y con el
# mercado cerrado los precios son los del último cierre (obsoletos). La franja
# recomendada es media sesión, con el mercado ya asentado.

BEST_START_ET = (10, 30)   # 10:30 ET
BEST_END_ET = (15, 30)     # 15:30 ET


def timing_advice(now_et=None):
    """Evalúa si es buen momento para calcular y traduce la franja ideal a CDMX."""
    now_et = now_et or datetime.now(MARKET_TZ)
    now_cdmx = now_et.astimezone(CDMX_TZ)
    minutes = now_et.hour * 60 + now_et.minute
    is_weekday = now_et.weekday() < 5
    open_m, close_m = 9 * 60 + 30, 16 * 60
    best_a = BEST_START_ET[0] * 60 + BEST_START_ET[1]
    best_b = BEST_END_ET[0] * 60 + BEST_END_ET[1]

    def to_cdmx(h, m):
        ref = now_et.replace(hour=h, minute=m, second=0, microsecond=0)
        return ref.astimezone(CDMX_TZ).strftime("%H:%M")

    if not is_weekday:
        quality, msg = "malo", "El mercado está cerrado (fin de semana): las primas son las del último cierre y pueden estar desactualizadas."
    elif minutes < open_m or minutes >= close_m:
        quality, msg = "malo", "El mercado está cerrado: las primas son las del último cierre y pueden estar desactualizadas."
    elif minutes < best_a:
        quality, msg = "regular", "Acaba de abrir el mercado: los spreads son anchos y los precios erráticos. Mejor esperar."
    elif minutes <= best_b:
        quality, msg = "bueno", "Buen momento: el mercado está abierto y asentado, con primas fiables."
    else:
        quality, msg = "regular", "Últimos minutos de la sesión: la liquidez baja y los precios se vuelven menos fiables."

    return {
        "quality": quality,
        "message": msg,
        "now_cdmx": now_cdmx.strftime("%H:%M"),
        "now_et": now_et.strftime("%H:%M"),
        "best_window_cdmx": f"{to_cdmx(*BEST_START_ET)} a {to_cdmx(*BEST_END_ET)}",
        "best_window_et": f"{BEST_START_ET[0]:02d}:{BEST_START_ET[1]:02d} a {BEST_END_ET[0]:02d}:{BEST_END_ET[1]:02d}",
        "market_open_cdmx": to_cdmx(9, 30),
        "market_close_cdmx": to_cdmx(16, 0),
    }


async def calculate(symbol: str, kind: str = "call"):
    """Cálculo completo (vencimiento más cercano) listo para guardar/mostrar."""
    chain = await fetch_chain(symbol)
    calc = build_calculation(chain, kind)
    calc["timing"] = timing_advice()
    now_cdmx = datetime.now(CDMX_TZ)
    calc["calculated_at_cdmx"] = now_cdmx.strftime("%Y-%m-%d %H:%M")
    calc["calculated_at_et"] = datetime.now(MARKET_TZ).strftime("%Y-%m-%d %H:%M")
    return calc
