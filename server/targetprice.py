"""Precio objetivo promedio de analistas (Target Price) vía stockanalysis.com,
fuente pública sin necesidad de API key. Twelve Data solo ofrece esto en planes
de pago (ultra/enterprise). Las ETFs y materias primas no tienen cobertura de
analistas, así que devuelve None para esos símbolos (404 esperado).
"""
import re

import httpx

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

TARGET_RE = re.compile(
    r'targets:\{low:([\d.]+),high:([\d.]+),count:(\d+),median:([\d.]+),'
    r'average:([\d.]+),updated:"([^"]+)"'
)


class TargetPriceError(Exception):
    pass


async def fetch_target_price(symbol: str) -> dict | None:
    async with httpx.AsyncClient(timeout=15, headers=HEADERS, follow_redirects=True) as client:
        r = await client.get(f"https://stockanalysis.com/stocks/{symbol}/forecast/")
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise TargetPriceError(f"stockanalysis.com respondió {r.status_code}")

    m = TARGET_RE.search(r.text)
    if not m:
        return None
    low, high, count, median, average, updated = m.groups()
    return {
        "average": float(average),
        "low": float(low),
        "high": float(high),
        "median": float(median),
        "count": int(count),
        "updated": updated,
    }
