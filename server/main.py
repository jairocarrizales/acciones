import asyncio
import base64
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from . import marketdata as md
from . import news
from . import rangos
from . import saltos
from . import targetprice as tp
from . import trends
from . import twelvedata as td

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
CAPTURAS = ROOT / "capturas"

db.init_db()
CAPTURAS.mkdir(exist_ok=True)

app = FastAPI(title="Plataforma de Acciones")

alarm_events: list[dict] = []  # eventos de alarma disparados, consumidos por el frontend


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/") and not request.url.path.startswith("/static/vendor/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


# ---------------- Settings ----------------

class ApiKeyIn(BaseModel):
    api_key: str


@app.get("/api/settings")
def get_settings():
    return {"api_key": db.get_setting("api_key", "")}


@app.post("/api/settings/api-key")
def set_api_key(body: ApiKeyIn):
    db.set_setting("api_key", body.api_key.strip())
    return {"ok": True}


def _api_key() -> str:
    key = db.get_setting("api_key", "")
    if not key:
        raise HTTPException(400, "Falta configurar la API key de Twelve Data en Configuración.")
    return key


# ---------------- Watchlist ----------------

@app.get("/api/watchlist")
def get_watchlist():
    return db.get_watchlist()


class GroupIn(BaseModel):
    name: str


@app.post("/api/watchlist/groups")
def create_group(body: GroupIn):
    gid = db.add_group(body.name.strip() or "Sin nombre")
    return {"id": gid}


@app.put("/api/watchlist/groups/{gid}")
def edit_group(gid: int, body: GroupIn):
    db.rename_group(gid, body.name.strip() or "Sin nombre")
    return {"ok": True}


@app.delete("/api/watchlist/groups/{gid}")
def remove_group(gid: int):
    db.delete_group(gid)
    return {"ok": True}


class MoveGroupIn(BaseModel):
    direction: str  # "up" | "down"


@app.put("/api/watchlist/groups/{gid}/move")
def move_group(gid: int, body: MoveGroupIn):
    if body.direction not in ("up", "down"):
        raise HTTPException(400, "direction debe ser 'up' o 'down'")
    db.move_group(gid, body.direction)
    return {"ok": True}


class SymbolIn(BaseModel):
    ticker: str
    name: str = ""
    group_id: int


@app.post("/api/watchlist/symbols")
def create_symbol(body: SymbolIn):
    sid = db.add_symbol(body.ticker.strip().upper(), body.name.strip(), body.group_id)
    return {"id": sid}


@app.delete("/api/watchlist/symbols/{sid}")
def remove_symbol(sid: int):
    db.delete_symbol(sid)
    return {"ok": True}


class MoveSymbolIn(BaseModel):
    group_id: int


@app.put("/api/watchlist/symbols/{sid}/move")
def move_symbol(sid: int, body: MoveSymbolIn):
    db.move_symbol(sid, body.group_id)
    return {"ok": True}


class FavoriteIn(BaseModel):
    favorite: bool


@app.put("/api/watchlist/symbols/{sid}/favorite")
def set_favorite(sid: int, body: FavoriteIn):
    db.set_favorite(sid, body.favorite)
    return {"ok": True}


@app.get("/api/search")
async def search(q: str):
    if not q or len(q) < 1:
        return []
    try:
        return await td.search_symbols(_api_key(), q.strip().upper())
    except td.TwelveDataError as e:
        raise HTTPException(502, str(e))


# ---------------- Candles ----------------

def _market_open_now() -> bool:
    """Sesión regular de EE. UU. (9:30-16:00 ET, lunes a viernes; feriados no contemplados)."""
    now_et = datetime.now(saltos.MARKET_TZ)
    if now_et.weekday() >= 5:
        return False
    m = now_et.hour * 60 + now_et.minute
    return 9 * 60 + 30 <= m < 16 * 60


async def _ensure_candles(symbol: str, interval: str, refresh: bool = False):
    """Refresca la caché de velas si hace falta y devuelve las velas guardadas.
    Con mercado abierto la vela en curso se refresca con más frecuencia."""
    now = int(time.time())
    last_fetch = db.get_fetch_time(symbol, interval)
    max_age = (td.STALENESS if _market_open_now() else td.STALENESS_CLOSED)[interval]
    stale = (now - last_fetch) > max_age

    if last_fetch == 0 or refresh or stale:
        try:
            start_ts = None
            existing = db.get_candles(symbol, interval)
            if existing and not refresh:
                start_ts = existing[-1]["time"] - 5 * 86400
            rows = await td.fetch_time_series(_api_key(), symbol, interval, start_ts)
            if rows:
                db.upsert_candles(symbol, interval, rows)
            db.set_fetch_time(symbol, interval, now)
        except td.TwelveDataError as e:
            existing = db.get_candles(symbol, interval)
            if not existing:
                raise HTTPException(502, str(e))

    return db.get_candles(symbol, interval)


@app.get("/api/candles/{symbol}/{interval}")
async def get_candles(symbol: str, interval: str, refresh: bool = False):
    symbol = symbol.upper()
    if interval not in td.INTERVAL_MAP:
        raise HTTPException(400, "Temporalidad inválida")
    return await _ensure_candles(symbol, interval, refresh)


# ---------------- Escáner de tendencia (SMA en D1 y H1) ----------------

TREND_TIMEFRAMES = ["1d", "1h"]
_trend_scan_state = {"running": False, "done": 0, "total": 0}


def _watchlist_tickers():
    seen, tickers = set(), []
    for g in db.get_watchlist():
        for s in g["symbols"]:
            if s["ticker"] not in seen:
                seen.add(s["ticker"])
                tickers.append(s["ticker"])
    return tickers


@app.get("/api/trend-scan")
def get_trend_scan():
    """Calcula la tendencia por SMA desde las velas ya cacheadas (instantáneo, sin API)."""
    result = {}
    for ticker in _watchlist_tickers():
        result[ticker] = {
            tf: trends.compute_trend(db.get_candles(ticker, tf), tf) for tf in TREND_TIMEFRAMES
        }
    return {"trends": result, "status": dict(_trend_scan_state)}


async def _trend_scan_worker():
    tickers = _watchlist_tickers()
    _trend_scan_state.update(running=True, done=0, total=len(tickers) * len(TREND_TIMEFRAMES))
    try:
        now = int(time.time())
        for ticker in tickers:
            for tf in TREND_TIMEFRAMES:
                last_fetch = db.get_fetch_time(ticker, tf)
                will_fetch = (now - last_fetch) > td.STALENESS[tf]
                try:
                    await _ensure_candles(ticker, tf, refresh=False)
                except Exception:
                    pass
                _trend_scan_state["done"] += 1
                # Solo esperamos cuando pegamos a la API, para respetar el
                # límite del plan gratuito (~8 req/min) sin ralentizar los aciertos de caché.
                if will_fetch:
                    await asyncio.sleep(8)
    finally:
        _trend_scan_state["running"] = False


@app.post("/api/trend-scan/refresh")
async def refresh_trend_scan():
    if _trend_scan_state["running"]:
        return {"ok": True, "already_running": True, "status": dict(_trend_scan_state)}
    asyncio.create_task(_trend_scan_worker())
    return {"ok": True, "status": dict(_trend_scan_state)}


# ---------------- Escáner de saltos (consolidación premarket + gap de apertura) ----------------

from datetime import time as dtime  # noqa: E402

_saltos_state = {
    "date": None,        # día de mercado (ET) al que pertenece el escaneo
    "phase": "esperando",  # esperando | consolidado | evaluado
    "updated_at": None,
    "scanning": False,
    "candidates": {},    # ticker -> {range_*, status, operation, jump, open_price}
}


def _get_jump_pct():
    """% del rango consolidado que debe superar la apertura para contar como salto."""
    try:
        v = float(db.get_setting("saltos_jump_pct", str(saltos.DEFAULT_JUMP_PCT)))
        return v if 0 < v <= 1000 else saltos.DEFAULT_JUMP_PCT
    except (TypeError, ValueError):
        return saltos.DEFAULT_JUMP_PCT


def _premarket_cutoff_ts():
    """Epoch de las 9:30 ET de hoy si ya abrió el mercado (para reevaluar la
    consolidación del premarket después de la apertura); None si aún no abre."""
    now_et = datetime.now(saltos.MARKET_TZ)
    if now_et.weekday() < 5 and now_et.time() >= dtime(9, 30):
        return int(now_et.replace(hour=9, minute=30, second=0, microsecond=0).timestamp())
    return None


async def _saltos_scan(cutoff_ts=None):
    """Escanea toda la watchlist buscando consolidación; reemplaza los candidatos."""
    _saltos_state["scanning"] = True
    try:
        tickers = _watchlist_tickers()
        sem = asyncio.Semaphore(5)
        async with saltos.make_client() as client:
            async def one(t):
                async with sem:
                    return t, await saltos.scan_symbol(client, t, cutoff_ts)
            results = await asyncio.gather(*(one(t) for t in tickers))
        candidates = {}
        for t, c in results:
            if c:
                c.update(status="consolidado", operation=None, jump=None, open_price=None)
                candidates[t] = c
        now_et = datetime.now(saltos.MARKET_TZ)
        _saltos_state.update(
            date=now_et.strftime("%Y-%m-%d"), phase="consolidado",
            updated_at=now_et.strftime("%H:%M:%S ET"), candidates=candidates,
        )
    finally:
        _saltos_state["scanning"] = False


async def _saltos_evaluate(use_last_price=False, finalize=True, until_minute=35):
    """Evalúa el movimiento de apertura de cada candidato contra su rango consolidado.

    Una sola pasada de la ventana de vigilancia: mira las velas de 1 min desde las 9:30
    hasta 9:until_minute y marca el salto en cuanto el precio se aleja lo suficiente.
    Un candidato ya marcado como salto no se reevalúa (la señal no se retira).
    finalize=False deja la fase en "consolidado" para que la vigilancia continúe.
    """
    cands = _saltos_state["candidates"]
    if not cands:
        return
    pending = [t for t in cands if cands[t].get("status") not in ("salto_alza", "salto_baja")]
    if not pending:
        # Todos marcados ya: no hay nada que reevaluar, pero la ventana debe poder cerrarse.
        if finalize:
            _saltos_state["phase"] = "evaluado"
            _saltos_state["updated_at"] = datetime.now(saltos.MARKET_TZ).strftime("%H:%M:%S ET")
        return
    sem = asyncio.Semaphore(5)
    async with saltos.make_client() as client:
        async def one(t):
            async with sem:
                snap = None
                if not use_last_price:
                    snap = await saltos.fetch_open_snapshot(client, t, until_minute)
                if snap is None:
                    price = await saltos.fetch_last_price(client, t)
                    snap = {"open": None, "high": None, "low": None, "last": price}
                return t, snap
        results = await asyncio.gather(*(one(t) for t in pending))
    mult = _get_jump_pct() / 100.0
    for t, snap in results:
        # Se evalúa el precio que más se alejó del rango durante la ventana de apertura
        # (apertura, máximo o mínimo acumulados), no solo la apertura exacta.
        prices = [p for p in (snap["open"], snap["high"], snap["low"], snap.get("last")) if p is not None]
        if not prices:
            continue
        eval_price = saltos.pick_extreme(cands[t], prices)
        verdict = saltos.judge_jump(cands[t], eval_price, mult)
        shown_open = snap["open"] if snap["open"] is not None else eval_price
        cands[t].update(open_price=round(shown_open, 4), eval_price=round(eval_price, 4), **verdict)
    now_et = datetime.now(saltos.MARKET_TZ)
    # Una prueba manual antes de la apertura no marca la fase, para no suprimir
    # la evaluación real de la ventana (que solo corre si la fase es "consolidado").
    if finalize and (not use_last_price or now_et.time() >= dtime(9, 30)):
        _saltos_state["phase"] = "evaluado"
    _saltos_state["updated_at"] = now_et.strftime("%H:%M:%S ET")


async def saltos_watcher():
    """Escanea cada ~10 min de 7:30 a 9:30 ET y evalúa el gap a las 9:30:05.
    Si el servidor arranca después de las 9:30 sin haber escaneado hoy (p. ej. la PC
    se reinició), reconstruye la consolidación del premarket y evalúa retroactivamente."""
    last_scan_ts = 0.0
    while True:
        try:
            now_et = datetime.now(saltos.MARKET_TZ)
            today = now_et.strftime("%Y-%m-%d")
            if now_et.weekday() < 5:
                t = now_et.time()
                if dtime(7, 30) <= t < dtime(9, 30):
                    if time.time() - last_scan_ts > 600 and not _saltos_state["scanning"]:
                        await _saltos_scan()
                        last_scan_ts = time.time()
                elif dtime(9, 30, 5) <= t < dtime(16, 0):
                    in_window = t < dtime(9, 35)  # ventana de vigilancia de la apertura
                    if _saltos_state["date"] == today and _saltos_state["phase"] == "consolidado":
                        # Durante la ventana se revisa repetidamente (cada ~10 s) y el salto
                        # se marca en cuanto aparece; al cerrarse la ventana se da por evaluado.
                        await _saltos_evaluate(finalize=not in_window)
                    elif _saltos_state["date"] != today and not _saltos_state["scanning"]:
                        # Recuperación: el premarket de hoy no se escaneó (servidor apagado).
                        await _saltos_scan(cutoff_ts=_premarket_cutoff_ts())
                        await _saltos_evaluate(finalize=not in_window)
        except Exception:
            pass
        # Cerca de la apertura afinamos el reloj para disparar a las 9:30:05 en punto,
        # y durante la ventana 9:30-9:35 se revisa cada 10 s.
        now_et = datetime.now(saltos.MARKET_TZ)
        t = now_et.time()
        if now_et.weekday() < 5 and dtime(9, 28) <= t < dtime(9, 31):
            delay = 1
        elif now_et.weekday() < 5 and dtime(9, 31) <= t < dtime(9, 35):
            delay = 10
        else:
            delay = 30
        await asyncio.sleep(delay)


def _get_saltos_hearts():
    try:
        return json.loads(db.get_setting("saltos_hearts", "[]"))
    except (ValueError, TypeError):
        return []


def _saltos_response():
    return {**_saltos_state, "hearts": _get_saltos_hearts(), "jump_pct": _get_jump_pct()}


@app.get("/api/saltos")
def get_saltos():
    return _saltos_response()


class SaltosConfigIn(BaseModel):
    jump_pct: float


@app.post("/api/saltos/config")
def set_saltos_config(body: SaltosConfigIn):
    if not (0 < body.jump_pct <= 1000):
        raise HTTPException(400, "jump_pct debe estar entre 0 y 1000")
    db.set_setting("saltos_jump_pct", str(body.jump_pct))
    return {"jump_pct": _get_jump_pct()}


@app.post("/api/saltos/hearts/{ticker}")
def toggle_saltos_heart(ticker: str):
    """Marca/desmarca un favorito de saltos. El recién marcado pasa al frente."""
    ticker = ticker.upper()
    hearts = _get_saltos_hearts()
    if ticker in hearts:
        hearts.remove(ticker)
    else:
        hearts.insert(0, ticker)
    db.set_setting("saltos_hearts", json.dumps(hearts))
    return {"tickers": hearts}


@app.post("/api/saltos/scan")
async def manual_saltos_scan():
    """Escaneo manual. Tras la apertura reconstruye la consolidación del premarket
    de hoy (corte a las 9:30 ET); antes de abrir usa las últimas velas disponibles."""
    if not _saltos_state["scanning"]:
        await _saltos_scan(cutoff_ts=_premarket_cutoff_ts())
    return _saltos_response()


@app.post("/api/saltos/evaluate")
async def manual_saltos_evaluate():
    """Reevaluación manual: si ya pasaron las 9:30 usa la apertura real de esa vela;
    antes de la apertura usa el último precio (simulacro)."""
    past_open = _premarket_cutoff_ts() is not None
    await _saltos_evaluate(use_last_price=not past_open)
    return _saltos_response()


_ext_cache: dict[tuple[str, str], tuple[float, list]] = {}
EXT_CACHE_TTL = {"m15": 120, "1h": 480}


@app.get("/api/candles-ext/{symbol}/{interval}")
async def get_candles_ext(symbol: str, interval: str, refresh: bool = False):
    """Velas intradía con sesión extendida (pre + post), como TC2000 con 'ext' activado."""
    symbol = symbol.upper()
    if interval not in md.EXT_INTERVAL:
        raise HTTPException(400, "Sesión extendida solo para m15 y 1h")
    now = time.time()
    cached = _ext_cache.get((symbol, interval))
    if not refresh and cached and (now - cached[0]) < EXT_CACHE_TTL[interval]:
        return cached[1]
    try:
        rows = await md.fetch_extended_candles(symbol, interval)
    except md.MarketDataError as e:
        if cached:
            return cached[1]
        raise HTTPException(502, str(e))
    _ext_cache[(symbol, interval)] = (now, rows)
    return rows


def _date_to_ts(date_str: str) -> int:
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


class EarningsIn(BaseModel):
    symbol: str
    date: str  # YYYY-MM-DD
    status: str = "reportado"  # 'reportado' | 'confirmado' | 'estimado'
    time_of_day: str = ""  # 'BMO' | 'AMC' | ''
    eps_estimate: float | None = None
    eps_actual: float | None = None
    note: str = ""


@app.get("/api/earnings/next-all")
def get_next_earnings_all():
    # Incluye también los reportes recientes: así el badge sigue visible los 2 días
    # posteriores al earnings (para entender los movimientos) y desaparece solo.
    # Son 3*86400 porque la fecha se guarda a medianoche UTC y los reportes AMC
    # ocurren ~16 h más tarde: con 2 exactos el badge moría un día antes.
    now_ts = int(datetime.now(tz=timezone.utc).timestamp())
    return db.get_next_earnings_all(now_ts - 3 * 86400)


@app.get("/api/earnings/{symbol}")
def get_earnings(symbol: str):
    symbol = symbol.upper()
    data = db.get_earnings(symbol)

    today = datetime.now(tz=timezone.utc)
    future = [e for e in data if e["ts"] > today.timestamp()]
    next_estimate = None
    next_estimate_is_guess = False
    if future:
        next_estimate = future[-1]["date"]  # el más próximo (ya viene ordenado desc)
    elif data:
        last_date = datetime.fromtimestamp(data[0]["ts"], tz=timezone.utc)
        candidate = last_date + timedelta(days=91)
        while candidate < today:
            candidate += timedelta(days=91)
        next_estimate = candidate.strftime("%Y-%m-%d")
        next_estimate_is_guess = True

    return {"earnings": data, "next_estimate": next_estimate, "next_estimate_is_guess": next_estimate_is_guess}


@app.post("/api/earnings")
def create_earnings(body: EarningsIn):
    if body.status not in ("reportado", "confirmado", "estimado"):
        raise HTTPException(400, "status debe ser 'reportado', 'confirmado' o 'estimado'")
    if body.time_of_day not in ("", "BMO", "AMC"):
        raise HTTPException(400, "time_of_day debe ser 'BMO', 'AMC' o vacío")
    try:
        ts = _date_to_ts(body.date)
    except ValueError:
        raise HTTPException(400, "Formato de fecha inválido, usa YYYY-MM-DD")
    eid = db.add_earnings(body.symbol.upper(), body.date, ts, body.status, body.time_of_day,
                           body.eps_estimate, body.eps_actual, body.note)
    return {"id": eid}


@app.delete("/api/earnings/{eid}")
def remove_earnings(eid: int):
    db.delete_earnings(eid)
    return {"ok": True}


@app.get("/api/price/{symbol}")
async def get_price(symbol: str):
    try:
        prices = await td.fetch_prices(_api_key(), [symbol.upper()])
    except td.TwelveDataError as e:
        raise HTTPException(502, str(e))
    if symbol.upper() not in prices:
        raise HTTPException(502, "Sin precio disponible")
    return {"symbol": symbol.upper(), "price": prices[symbol.upper()]}


_premarket_cache: dict[str, tuple[float, dict]] = {}
PREMARKET_CACHE_TTL = 60  # segundos


@app.get("/api/premarket/{symbol}")
async def get_premarket(symbol: str):
    symbol = symbol.upper()
    now = time.time()
    cached = _premarket_cache.get(symbol)
    if cached and (now - cached[0]) < PREMARKET_CACHE_TTL:
        return cached[1]
    try:
        quote = await md.fetch_session_quote(symbol)
    except md.MarketDataError as e:
        raise HTTPException(502, str(e))
    _premarket_cache[symbol] = (now, quote)
    return quote


_news_cache: dict[str, tuple[float, list]] = {}
NEWS_CACHE_TTL = 900  # 15 minutos


@app.get("/api/news/{symbol}")
async def get_news(symbol: str, refresh: bool = False):
    symbol = symbol.upper()
    now = time.time()
    cached = _news_cache.get(symbol)
    if not refresh and cached and (now - cached[0]) < NEWS_CACHE_TTL:
        return cached[1]
    try:
        items = await news.fetch_news(symbol)
    except news.NewsError as e:
        if cached:
            return cached[1]
        raise HTTPException(502, str(e))
    _news_cache[symbol] = (now, items)
    return items


_target_cache: dict[str, tuple[float, dict | None]] = {}
TARGET_CACHE_TTL = 21600  # 6 horas (el precio objetivo no cambia con frecuencia)


@app.get("/api/target-price/{symbol}")
async def get_target_price(symbol: str):
    symbol = symbol.upper()
    now = time.time()
    cached = _target_cache.get(symbol)
    if cached and (now - cached[0]) < TARGET_CACHE_TTL:
        return cached[1]
    try:
        data = await tp.fetch_target_price(symbol)
    except tp.TargetPriceError as e:
        if cached:
            return cached[1]
        raise HTTPException(502, str(e))
    _target_cache[symbol] = (now, data)
    return data


# ---------------- Drawings (líneas de tendencia) ----------------

class DrawingIn(BaseModel):
    symbol: str
    interval: str
    type: str
    data: dict


@app.get("/api/drawings-all")
def get_all_drawings():
    return db.get_all_drawings()


@app.get("/api/drawings/{symbol}/{interval}")
def get_drawings(symbol: str, interval: str):
    return db.get_drawings(symbol.upper(), interval)


@app.post("/api/drawings")
def create_drawing(body: DrawingIn):
    did = db.add_drawing(body.symbol.upper(), body.interval, body.type, body.data)
    return {"id": did}


class DrawingUpdateIn(BaseModel):
    data: dict


@app.put("/api/drawings/{did}")
def update_drawing(did: int, body: DrawingUpdateIn):
    db.update_drawing(did, body.data)
    return {"ok": True}


@app.delete("/api/drawings/{did}")
def remove_drawing(did: int):
    db.delete_drawing(did)
    return {"ok": True}


# ---------------- Notes (diario de análisis) ----------------

class NoteIn(BaseModel):
    symbol: str
    text: str


@app.get("/api/notes/{symbol}")
def get_notes(symbol: str):
    return db.get_notes(symbol.upper())


@app.post("/api/notes")
def create_note(body: NoteIn):
    nid = db.add_note(body.symbol.upper(), body.text)
    return {"id": nid}


class NoteUpdateIn(BaseModel):
    text: str


@app.put("/api/notes/{nid}")
def edit_note(nid: int, body: NoteUpdateIn):
    db.update_note(nid, body.text)
    return {"ok": True}


@app.delete("/api/notes/{nid}")
def remove_note(nid: int):
    db.delete_note(nid)
    return {"ok": True}


# ---------------- Alarms ----------------

class AlarmIn(BaseModel):
    symbol: str
    price: float
    direction: str  # "above" | "below"
    note: str = ""


@app.get("/api/alarms")
def get_alarms(symbol: str | None = None):
    return db.get_alarms(symbol.upper() if symbol else None)


@app.post("/api/alarms")
def create_alarm(body: AlarmIn):
    if body.direction not in ("above", "below"):
        raise HTTPException(400, "direction debe ser 'above' o 'below'")
    aid = db.add_alarm(body.symbol.upper(), body.price, body.direction, body.note)
    return {"id": aid}


@app.post("/api/alarms/{aid}/reactivate")
def reactivate_alarm(aid: int):
    db.reactivate_alarm(aid)
    return {"ok": True}


@app.delete("/api/alarms/{aid}")
def remove_alarm(aid: int):
    db.delete_alarm(aid)
    return {"ok": True}


@app.get("/api/alarms/events")
def poll_alarm_events():
    """El frontend hace polling aquí para sonido/notificación; consume la cola."""
    global alarm_events
    events, alarm_events = alarm_events, []
    return events


# ---------------- Rango de precios (cadena de opciones) ----------------

class RangoIn(BaseModel):
    symbol: str
    kind: str = "call"  # 'call' | 'put'
    min_price: float | None = None
    count: int | None = None


def _rango_opts(body: RangoIn):
    """Ajustes efectivos: los del cuerpo o los guardados por el usuario."""
    if body.kind not in ("call", "put"):
        raise HTTPException(400, "kind debe ser 'call' o 'put'")
    cfg = _get_rangos_config()
    min_price = body.min_price if body.min_price is not None else cfg["min_price"]
    count = body.count if body.count is not None else cfg["count"]
    if min_price < 0 or count < 1 or count > 100:
        raise HTTPException(400, "Ajustes inválidos (precio mínimo ≥ 0, cantidad entre 1 y 100)")
    return min_price, count


class RangosConfigIn(BaseModel):
    min_price: float
    count: int


def _get_rangos_config():
    try:
        cfg = json.loads(db.get_setting("rangos_config", "") or "{}")
    except (ValueError, TypeError):
        cfg = {}
    return {
        "min_price": float(cfg.get("min_price", rangos.DEFAULT_MIN_PRICE)),
        "count": int(cfg.get("count", rangos.DEFAULT_COUNT)),
    }


@app.get("/api/rangos/config")
def get_rangos_config():
    return _get_rangos_config()


@app.post("/api/rangos/config")
def set_rangos_config(body: RangosConfigIn):
    if body.min_price < 0 or body.count < 1 or body.count > 100:
        raise HTTPException(400, "Ajustes inválidos (precio mínimo ≥ 0, cantidad entre 1 y 100)")
    db.set_setting("rangos_config", json.dumps({"min_price": body.min_price, "count": body.count}))
    return _get_rangos_config()


@app.post("/api/rangos/calcular")
async def calcular_rango(body: RangoIn):
    """Calcula el rango SIN guardarlo (vista previa)."""
    min_price, count = _rango_opts(body)
    try:
        return await rangos.calculate(body.symbol.strip().upper(), body.kind, min_price, count)
    except rangos.RangosError as e:
        raise HTTPException(502, str(e))


@app.post("/api/rangos")
async def guardar_rango(body: RangoIn):
    """Calcula y guarda el cálculo completo en la base de datos."""
    min_price, count = _rango_opts(body)
    try:
        calc = await rangos.calculate(body.symbol.strip().upper(), body.kind, min_price, count)
    except rangos.RangosError as e:
        raise HTTPException(502, str(e))
    rid = db.add_rango(calc["symbol"], calc["kind"], calc["expiration"], calc["spot"],
                       calc["direction"], calc["change_pct"], calc)
    return {"id": rid, **calc}


@app.get("/api/rangos")
def listar_rangos(symbol: str | None = None):
    return db.get_rangos(symbol)


@app.get("/api/rangos/{rid}")
def ver_rango(rid: int):
    r = db.get_rango(rid)
    if not r:
        raise HTTPException(404, "Cálculo no encontrado")
    return r


@app.delete("/api/rangos/{rid}")
def borrar_rango(rid: int):
    db.delete_rango(rid)
    return {"ok": True}


# ---------------- MA config ----------------

class MAConfigIn(BaseModel):
    scope: str  # "global" o un ticker
    config: list[dict]


@app.get("/api/ma-config")
def get_ma_config(symbol: str | None = None):
    return db.get_ma_config(symbol.upper() if symbol else None)


@app.post("/api/ma-config")
def set_ma_config(body: MAConfigIn):
    db.set_ma_config(body.scope if body.scope == "global" else body.scope.upper(), body.config)
    return {"ok": True}


@app.delete("/api/ma-config/{scope}")
def reset_ma_config(scope: str):
    db.delete_ma_config(scope.upper())
    return {"ok": True}


# ---------------- Capturas ----------------

class SnapshotIn(BaseModel):
    symbol: str
    interval: str
    image: str  # data URL base64 png


@app.post("/api/snapshot")
def save_snapshot(body: SnapshotIn):
    header, encoded = body.image.split(",", 1) if "," in body.image else ("", body.image)
    raw = base64.b64decode(encoded)
    ts = time.strftime("%Y%m%d-%H%M%S")
    fname = f"{body.symbol.upper()}_{body.interval}_{ts}.png"
    (CAPTURAS / fname).write_bytes(raw)
    return {"file": fname}


@app.get("/api/capturas")
def list_snapshots():
    files = sorted(CAPTURAS.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [f.name for f in files]


app.mount("/capturas", StaticFiles(directory=str(CAPTURAS)), name="capturas")


# ---------------- Alarm watcher (background) ----------------

async def alarm_watcher():
    while True:
        try:
            active = db.get_active_alarms()
            if active:
                symbols = sorted({a["symbol"] for a in active})
                key = db.get_setting("api_key", "")
                if key:
                    try:
                        prices = await td.fetch_prices(key, symbols)
                    except td.TwelveDataError:
                        prices = {}
                    for a in active:
                        price = prices.get(a["symbol"])
                        if price is None:
                            continue
                        hit = (a["direction"] == "above" and price >= a["price"]) or \
                              (a["direction"] == "below" and price <= a["price"])
                        if hit:
                            db.trigger_alarm(a["id"], price)
                            alarm_events.append({
                                "id": a["id"], "symbol": a["symbol"], "price": price,
                                "target": a["price"], "direction": a["direction"], "note": a["note"],
                            })
        except Exception:
            pass
        await asyncio.sleep(60)


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(alarm_watcher())
    asyncio.create_task(saltos_watcher())


# ---------------- Static frontend ----------------

app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC / "index.html"))
