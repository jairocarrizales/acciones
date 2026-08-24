"""Cliente de la API de Twelve Data (plan gratuito: 8 peticiones/min, 800/día)."""
import calendar
from datetime import datetime, timezone

import httpx

BASE = "https://api.twelvedata.com"

INTERVAL_MAP = {"m1": "1min", "m2": "1min", "m5": "5min", "m15": "15min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week"}

# Segundos de antigüedad máxima de la caché antes de volver a pedir a la API
# Con mercado abierto la vela en curso se refresca a este ritmo (el gráfico consulta
# solo; con ~800 peticiones/día en el plan gratuito, 60 s en M15 son ~390 peticiones
# por sesión para UN panel activo — sostenible). Fuera de horario, cada hora basta.
STALENESS = {"m1": 30, "m2": 30, "m5": 45, "m15": 60, "1h": 120, "4h": 300, "1d": 300, "1w": 900}
STALENESS_CLOSED = {"m1": 3600, "m2": 3600, "m5": 3600, "m15": 3600, "1h": 3600, "4h": 3600, "1d": 3600, "1w": 7200}


class TwelveDataError(Exception):
    pass


def _parse_ts(s: str) -> int:
    # Twelve Data devuelve hora local de mercado (America/New_York); la guardamos
    # como epoch "naive" para que el gráfico muestre la hora de mercado.
    fmt = "%Y-%m-%d %H:%M:%S" if " " in s else "%Y-%m-%d"
    dt = datetime.strptime(s, fmt)
    return calendar.timegm(dt.timetuple())


def _ts_to_str(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


async def fetch_time_series(api_key: str, symbol: str, interval: str, start_ts: int | None = None):
    params = {
        "symbol": symbol,
        "interval": INTERVAL_MAP[interval],
        "outputsize": 5000,
        "timezone": "America/New_York",
        "apikey": api_key,
    }
    if start_ts:
        params["start_date"] = _ts_to_str(start_ts)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{BASE}/time_series", params=params)
    data = r.json()
    if data.get("status") == "error" or "values" not in data:
        raise TwelveDataError(data.get("message", f"respuesta inesperada ({r.status_code})"))
    rows = []
    for v in data["values"]:
        try:
            rows.append({
                "ts": _parse_ts(v["datetime"]),
                "open": float(v["open"]),
                "high": float(v["high"]),
                "low": float(v["low"]),
                "close": float(v["close"]),
                "volume": float(v.get("volume") or 0),
            })
        except (KeyError, ValueError):
            continue
    rows.sort(key=lambda x: x["ts"])
    return rows


async def fetch_prices(api_key: str, symbols: list[str]) -> dict[str, float]:
    """Precio actual de uno o varios símbolos. Devuelve {ticker: precio}."""
    if not symbols:
        return {}
    params = {"symbol": ",".join(symbols), "apikey": api_key}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{BASE}/price", params=params)
    data = r.json()
    prices: dict[str, float] = {}
    if len(symbols) == 1:
        if "price" in data:
            prices[symbols[0]] = float(data["price"])
        elif data.get("status") == "error":
            raise TwelveDataError(data.get("message", "error de precio"))
    else:
        for sym in symbols:
            entry = data.get(sym)
            if isinstance(entry, dict) and "price" in entry:
                prices[sym] = float(entry["price"])
    return prices


async def search_symbols(api_key: str, query: str):
    params = {"symbol": query, "outputsize": 15, "apikey": api_key}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{BASE}/symbol_search", params=params)
    data = r.json()
    if data.get("status") == "error":
        raise TwelveDataError(data.get("message", "error de búsqueda"))
    results = []
    for item in data.get("data", []):
        results.append({
            "ticker": item.get("symbol", ""),
            "name": item.get("instrument_name", ""),
            "exchange": item.get("exchange", ""),
            "type": item.get("instrument_type", ""),
            "country": item.get("country", ""),
        })
    return results
