"""Noticias financieras por símbolo (últimas 24h) vía la API pública de búsqueda de
Yahoo Finance, que agrega medios financieros reales (Reuters, Bloomberg, Barron's,
The Wall Street Journal, Motley Fool, Benzinga, etc.) cuando existen para el símbolo.
Los títulos se traducen al español con la API gratuita de MyMemory.

Nota: wsj.com y marketwatch.com bloquean el acceso automatizado (401) y el RSS público
de WSJ está descontinuado, por lo que no es posible enlazar directamente a wsj.com; el
enlace de estos artículos apunta a la página de finance.yahoo.com que aloja la copia
sindicada, con atribución correcta a la fuente original.
"""
import time

import httpx

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
DAY_SECONDS = 86400

_translation_cache: dict[str, str] = {}


class NewsError(Exception):
    pass


async def _translate(text: str) -> str:
    if not text:
        return text
    if text in _translation_cache:
        return _translation_cache[text]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.mymemory.translated.net/get",
                params={"q": text, "langpair": "en|es"},
            )
        data = r.json()
        translated = (data.get("responseData") or {}).get("translatedText")
        if not translated:
            return text
        _translation_cache[text] = translated
        return translated
    except Exception:
        return text


async def fetch_news(symbol: str) -> list[dict]:
    params = {"q": symbol, "newsCount": 20, "quotesCount": 0}
    async with httpx.AsyncClient(timeout=15, headers=HEADERS) as client:
        r = await client.get("https://query1.finance.yahoo.com/v1/finance/search", params=params)
    if r.status_code != 200:
        raise NewsError(f"Yahoo Finance respondió {r.status_code}")
    data = r.json()
    items = data.get("news") or []

    now = time.time()
    recent = [n for n in items if (now - (n.get("providerPublishTime") or 0)) <= DAY_SECONDS]

    results = []
    for n in recent:
        title = n.get("title", "")
        title_es = await _translate(title)
        thumb_list = (n.get("thumbnail") or {}).get("resolutions") or []
        thumb = next((t["url"] for t in thumb_list if t.get("tag") == "140x140"), None) \
            or (thumb_list[0]["url"] if thumb_list else None)
        results.append({
            "title": title,
            "title_es": title_es,
            "publisher": n.get("publisher", ""),
            "link": n.get("link", ""),
            "published_ts": n.get("providerPublishTime"),
            "thumbnail": thumb,
        })
    results.sort(key=lambda x: x["published_ts"] or 0, reverse=True)
    return results
