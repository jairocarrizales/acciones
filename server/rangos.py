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


# Ajustes por defecto del cálculo (configurables desde la tuerca del panel).
# El mínimo se expresa en DÓLARES DE COSTO del contrato: como cada contrato
# cubre 100 acciones, $20 equivale a una prima de 0.20 en la cadena de opciones.
DEFAULT_MIN_PRICE = 20.0   # coste mínimo del contrato en dólares
DEFAULT_MAX_PRICE = 600.0  # coste máximo del contrato en dólares
DEFAULT_COUNT = 8          # cuántos contratos se usan (máximo)
CONTRACT_SIZE = 100        # acciones por contrato


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


async def fetch_day_ranges(symbols):
    """Mínimo y máximo del día de cada contrato ("Day's Range" de su ficha en Yahoo).

    No viene en la cadena de opciones: hay que consultar cada contrato por separado.
    Devuelve {contractSymbol: (low, high)}; los que fallen quedan fuera.
    """
    out = {}
    if not symbols:
        return out
    client, crumb = await _client_with_crumb()
    try:
        sem = asyncio.Semaphore(5)

        async def one(cs):
            async with sem:
                try:
                    r = await client.get(
                        f"https://query1.finance.yahoo.com/v8/finance/chart/{cs}",
                        params={"range": "1d", "interval": "1m", "crumb": crumb})
                    meta = ((r.json().get("chart") or {}).get("result") or [{}])[0].get("meta") or {}
                    lo, hi = meta.get("regularMarketDayLow"), meta.get("regularMarketDayHigh")
                    if lo is not None and hi is not None and hi > 0:
                        out[cs] = (lo, hi)
                except (httpx.HTTPError, ValueError, KeyError, IndexError):
                    pass

        await asyncio.gather(*(one(cs) for cs in symbols))
    finally:
        await client.aclose()
    return out


def _row(contract, spot, kind):
    """Fila del cálculo para un contrato: strike, precio, coste y rango del día.

    El precio es el ASK (lo que cuesta comprar el contrato ahora mismo); el
    "último negociado" solo se usa como respaldo cuando no hay ask.
    """
    strike = contract.get("strike")
    bid, ask = contract.get("bid") or 0, contract.get("ask") or 0
    last = contract.get("lastPrice")
    # El precio es el ASK: lo que realmente cuesta comprar el contrato.
    price = ask if ask > 0 else last
    price_source = "ask" if ask > 0 else "ultimo"
    if strike is None or price is None:
        return None
    # Call: equilibrio por encima (strike + prima). Put: por debajo (strike - prima).
    rango = strike + price if kind == "call" else strike - price
    pct = (rango / spot - 1) * 100 if spot else 0.0
    return {
        "contract": contract.get("contractSymbol"),
        "strike": round(strike, 4),
        "price": round(price, 4),
        "cost": round(price * CONTRACT_SIZE, 2),  # lo que cuesta el contrato en dólares
        "price_source": price_source,
        "last": round(last, 4) if last is not None else None,
        "range": round(rango, 4),
        "pct": round(pct, 3),
        "bid": contract.get("bid"),
        "ask": contract.get("ask"),
        "volume": contract.get("volume") or 0,
        "open_interest": contract.get("openInterest") or 0,
        "in_the_money": bool(contract.get("inTheMoney")),
    }


async def build_calculation(chain, kind="call", min_price=DEFAULT_MIN_PRICE,
                            max_price=DEFAULT_MAX_PRICE, count=DEFAULT_COUNT):
    """Construye el cálculo a partir de una cadena de opciones.

    Se usan solo los `count` contratos con precio >= `min_price` más cercanos al
    dinero (los de strike más próximo al precio actual), que son los relevantes;
    el rango óptimo resulta del menor y mayor de sus rangos.
    """
    quote = chain.get("quote") or {}
    spot = quote.get("regularMarketPrice")
    if not spot:
        raise RangosError("Sin precio actual del activo")

    options = (chain.get("options") or [{}])[0]
    contracts = options.get("calls" if kind == "call" else "puts") or []
    all_rows = [r for r in (_row(c, spot, kind) for c in contracts) if r]
    if not all_rows:
        raise RangosError("El vencimiento no tiene contratos con precio")

    # Filtro por precio mínimo y selección de los más cercanos al precio actual.
    # Solo contratos OTM (fuera del dinero), que son los que se usan en el método:
    # en calls, strike por encima del precio; en puts, por debajo.
    def is_otm(r):
        return r["strike"] > spot if kind == "call" else r["strike"] < spot

    def in_budget(r):
        return min_price <= r["price"] * CONTRACT_SIZE <= max_price

    # Todos los contratos cuyo coste cae dentro del presupuesto: primero los OTM
    # (los del método) y, si el presupuesto da para más, también los ITM.
    otm_ok = sorted([r for r in all_rows if is_otm(r) and in_budget(r)], key=lambda r: r["price"])
    itm_ok = sorted([r for r in all_rows if not is_otm(r) and in_budget(r)], key=lambda r: r["price"])
    rows = (otm_ok + itm_ok)[:count]
    if not rows:
        raise RangosError(
            f"Ningún contrato cuesta entre ${min_price:g} y ${max_price:g}. Ajusta los límites.")
    for r in rows:
        r["itm"] = not is_otm(r)
    rows.sort(key=lambda r: r["strike"])
    eligible = otm_ok

    exp_ts = options.get("expirationDate")
    prev_close = quote.get("regularMarketPreviousClose")
    change_pct = quote.get("regularMarketChangePercent")
    # Dirección del día: sirve para saber si el movimiento fue alcista o bajista.
    if change_pct is None and prev_close:
        change_pct = (spot / prev_close - 1) * 100

    # Rango óptimo: lo que CUESTA el contrato, del más barato al más caro de los
    # usados (es el rango de precio del contrato, no del precio de la acción).
    cost_values = [r["cost"] for r in rows]
    range_min, range_max = min(cost_values), max(cost_values)

    # Rango del día de cada contrato ("Day's Range"): el mínimo y el máximo que
    # llegó a costar la opción hoy. De ahí sale la rentabilidad del movimiento.
    day = await fetch_day_ranges([r["contract"] for r in rows if r.get("contract")])
    for r in rows:
        dr = day.get(r.get("contract"))
        if not dr:
            r["day_low"] = r["day_high"] = r["day_pct"] = None
            continue
        lo, hi = dr
        r["day_low"] = round(lo * CONTRACT_SIZE, 2)    # coste mínimo del día
        r["day_high"] = round(hi * CONTRACT_SIZE, 2)   # coste máximo del día
        r["day_pct"] = round((hi / lo - 1) * 100, 1) if lo > 0 else None

    # Se resaltan los dos de mayor rentabilidad del día, como en la hoja.
    with_pct = [r for r in rows if r.get("day_pct") is not None]
    for r in sorted(with_pct, key=lambda r: r["day_pct"], reverse=True)[:2]:
        r["best"] = True

    return {
        "symbol": (quote.get("symbol") or "").upper(),
        "kind": kind,
        "spot": round(spot, 4),
        "min_price": min_price,
        "max_price": max_price,
        "count": count,
        "range_min": round(range_min, 4),
        "range_max": round(range_max, 4),
        # Cuánto más caro es el contrato más caro respecto al más barato.
        "range_spread_pct": round((range_max / range_min - 1) * 100, 2) if range_min else None,
        "available": len(all_rows),
        "eligible": len(eligible),
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


async def calculate(symbol: str, kind: str = "call", min_price: float = DEFAULT_MIN_PRICE,
                    max_price: float = DEFAULT_MAX_PRICE, count: int = DEFAULT_COUNT):
    """Cálculo completo (vencimiento más cercano) listo para guardar/mostrar."""
    chain = await fetch_chain(symbol)
    calc = await build_calculation(chain, kind, min_price, max_price, count)
    calc["timing"] = timing_advice()
    now_cdmx = datetime.now(CDMX_TZ)
    calc["calculated_at_cdmx"] = now_cdmx.strftime("%Y-%m-%d %H:%M")
    calc["calculated_at_et"] = datetime.now(MARKET_TZ).strftime("%Y-%m-%d %H:%M")
    return calc
