"""Próxima reunión del FOMC, leída del calendario público de la Reserva Federal.

La Fed publica las fechas en HTML sin API; se parsean los paneles de cada año y se
guarda el resultado en memoria, porque el calendario cambia como mucho una vez al año.
"""
import re
from datetime import date, datetime

import httpx

URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

MESES = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june",
     "july", "august", "september", "october", "november", "december"], 1)}

_PANEL = re.compile(r'<div class="panel panel-default">(.*?)</div>\s*</div>\s*</div>', re.S)
_ANIO = re.compile(r'(\d{4})\s+FOMC Meetings')
_REUNION = re.compile(
    r'fomc-meeting__month[^>]*>\s*<strong>([^<]+)</strong>.*?'
    r'fomc-meeting__date[^>]*>([^<]+)<', re.S)

_cache: dict | None = None


def _dia_final(dias: str) -> int | None:
    """Del texto '27-28' o '8-9*' saca el día en que termina la reunión."""
    nums = re.findall(r"\d+", dias)
    return int(nums[-1]) if nums else None


def _parsear(html: str) -> list[dict]:
    reuniones = []
    for anio_txt, bloque in re.findall(r'(\d{4})\s+FOMC Meetings(.*?)(?=\d{4}\s+FOMC Meetings|$)',
                                       html, re.S):
        anio = int(anio_txt)
        for mes_txt, dias in _REUNION.findall(bloque):
            # "Apr/May" o "Jan/Feb": la reunión termina en el segundo mes
            mes_nombre = mes_txt.strip().split("/")[-1].strip().lower()
            mes = MESES.get(mes_nombre) or MESES.get(mes_nombre[:3] and
                                                     next((k for k in MESES if k.startswith(mes_nombre[:3])), ""))
            dia = _dia_final(dias)
            if not mes or not dia:
                continue
            # un cruce de meses avanza el año si el bloque empezaba en diciembre
            try:
                f = date(anio, mes, dia)
            except ValueError:
                continue
            reuniones.append({"date": f.isoformat(), "notacion": "notation" in dias.lower()})
    return sorted(reuniones, key=lambda r: r["date"])


async def proxima_reunion() -> dict | None:
    """Fecha de la próxima decisión del FOMC (el día en que termina la reunión)."""
    global _cache
    hoy = date.today().isoformat()
    if _cache and _cache.get("fetched") == hoy:
        reuniones = _cache["reuniones"]
    else:
        async with httpx.AsyncClient(timeout=20, headers=HEADERS, follow_redirects=True) as client:
            r = await client.get(URL)
        if r.status_code != 200:
            return None
        reuniones = _parsear(r.text)
        _cache = {"fetched": hoy, "reuniones": reuniones}

    for m in reuniones:
        if m["date"] >= hoy and not m["notacion"]:
            dias = (datetime.fromisoformat(m["date"]).date() - date.today()).days
            return {"date": m["date"], "dias": dias}
    return None
