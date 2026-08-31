"""Financial Modeling Prep como proveedor de respaldo.

Twelve Data agota su cuota diaria (800 peticiones en el plan gratuito) y entonces
el panel se queda sirviendo velas viejas de la caché. FMP cubre ese hueco, pero
solo en parte: con el plan actual da cotización en vivo y velas DIARIAS, mientras
que el intradía (1min, 5min, 1h, 4h) y el batch de cotizaciones están restringidos
al plan de pago. Por eso se usa como respaldo y no como fuente principal.

La clave se lee de la variable de entorno FMP_API_KEY o de los ajustes guardados.
"""
import os
from datetime import datetime, timezone

import httpx

BASE = "https://financialmodelingprep.com/stable"
TIMEOUT = 20

# Intervalos que este proveedor puede servir con el plan actual.
SOPORTA = ("1d",)


class FMPError(Exception):
    pass


def api_key(db=None) -> str:
    """Clave de FMP: primero el entorno, luego los ajustes del panel."""
    key = os.environ.get("FMP_API_KEY", "").strip()
    if key:
        return key
    if db is not None:
        return (db.get_setting("fmp_api_key") or "").strip()
    return ""


def _revisar(payload):
    """FMP devuelve los errores como texto plano o como objeto con mensaje."""
    if isinstance(payload, str):
        raise FMPError(payload[:200])
    if isinstance(payload, dict) and payload.get("Error Message"):
        raise FMPError(payload["Error Message"][:200])
    return payload


async def fetch_quote(key: str, symbol: str) -> dict | None:
    """Cotización en vivo de un símbolo."""
    if not key:
        raise FMPError("Falta la API key de FMP")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{BASE}/quote", params={"symbol": symbol, "apikey": key})
    if r.status_code != 200:
        raise FMPError(f"FMP respondió {r.status_code}")
    try:
        datos = _revisar(r.json())
    except ValueError:
        raise FMPError(r.text[:200])
    if not datos:
        return None
    q = datos[0]
    return {"symbol": q.get("symbol"), "price": q.get("price"),
            "change": q.get("change"), "change_percent": q.get("changePercentage")}


async def fetch_daily(key: str, symbol: str) -> list[dict]:
    """Velas diarias con la clave "ts", igual que las entrega Twelve Data.

    El epoch es la medianoche UTC del día, la misma convención que usa el
    proveedor principal, para que las velas encajen sin duplicarse.
    """
    if not key:
        raise FMPError("Falta la API key de FMP")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{BASE}/historical-price-eod/full",
                             params={"symbol": symbol, "apikey": key})
    if r.status_code != 200:
        raise FMPError(f"FMP respondió {r.status_code}")
    try:
        filas = _revisar(r.json())
    except ValueError:
        raise FMPError(r.text[:200])

    velas = []
    for f in filas or []:
        try:
            d = datetime.strptime(f["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        velas.append({
            "ts": int(d.timestamp()),
            "open": f.get("open"), "high": f.get("high"),
            "low": f.get("low"), "close": f.get("close"),
            "volume": f.get("volume") or 0,
        })
    velas.sort(key=lambda c: c["ts"])
    return velas
