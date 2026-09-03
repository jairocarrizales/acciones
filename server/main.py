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
from . import fomc
from . import fmp
from . import toques as tq
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
    fmp_api_key: str | None = None  # proveedor de respaldo


@app.get("/api/settings")
def get_settings():
    return {"api_key": db.get_setting("api_key", ""),
            "fmp_api_key": db.get_setting("fmp_api_key", "")}


@app.post("/api/settings/api-key")
def set_api_key(body: ApiKeyIn):
    db.set_setting("api_key", body.api_key.strip())
    if body.fmp_api_key is not None:
        db.set_setting("fmp_api_key", body.fmp_api_key.strip())
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
    sid, ya_en = db.add_symbol(body.ticker.strip().upper(), body.name.strip(), body.group_id)
    # ya_en trae el grupo donde estaba, para poder avisar en vez de duplicar en silencio
    return {"id": sid, "duplicado": ya_en}


@app.delete("/api/watchlist/symbols/{sid}")
def remove_symbol(sid: int):
    db.delete_symbol(sid)
    return {"ok": True}


class MoveSymbolIn(BaseModel):
    group_id: int
    before_id: int | None = None  # reordenar dentro del grupo, delante de este símbolo


@app.put("/api/watchlist/symbols/{sid}/move")
def move_symbol(sid: int, body: MoveSymbolIn):
    # con before_id se reordena dentro del grupo; sin él, va al final
    if body.before_id is not None:
        db.reorder_symbol(sid, body.group_id, body.before_id)
    else:
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


# Temporalidades que se construyen agrupando velas de 5 minutos a la HORA EN PUNTO
# (9:00, 10:00, 11:00...), como hace TC2000. El proveedor las entrega alineadas a la
# apertura (9:30, 10:30...), lo que produce cuerpos y mechas distintos con los mismos
# datos. Se agregan aquí para que los patrones coincidan.
AGREGADAS = {"1h": 1, "4h": 4}
# M30 se arma desde M15 (dos velas por bloque), alineado a la hora en punto.
AGREGADAS_DESDE_M15 = {"m30": 30}
AGREGADAS_MIN = {"m2": 2, "m3": 3, "m10": 10}  # minutos por vela, agrupados desde M1


def _agrupar_minutos(velas, minutos):
    """Agrupa velas de 1 min en velas de N minutos alineadas a la hora en punto."""
    bloques = {}
    for c in velas:
        dt = datetime.utcfromtimestamp(c["time"])
        m = (dt.minute // minutos) * minutos
        clave = dt.replace(minute=m, second=0, microsecond=0)
        ts = int(clave.replace(tzinfo=timezone.utc).timestamp())
        b = bloques.get(ts)
        if b is None:
            bloques[ts] = {"time": ts, "open": c["open"], "high": c["high"],
                           "low": c["low"], "close": c["close"], "volume": c.get("volume") or 0}
        else:
            b["high"] = max(b["high"], c["high"])
            b["low"] = min(b["low"], c["low"])
            b["close"] = c["close"]
            b["volume"] += c.get("volume") or 0
    return [bloques[k] for k in sorted(bloques)]


def _agrupar_desde_m15(m15, minutos):
    """Agrupa velas de 15 min en velas de N minutos alineadas a la hora en punto."""
    bloques = {}
    for c in m15:
        dt = datetime.utcfromtimestamp(c["time"])  # epoch 'naive' = hora de mercado
        m = (dt.minute // minutos) * minutos
        clave = dt.replace(minute=m, second=0, microsecond=0)
        ts = int(clave.replace(tzinfo=timezone.utc).timestamp())
        b = bloques.get(ts)
        if b is None:
            bloques[ts] = {"time": ts, "open": c["open"], "high": c["high"],
                           "low": c["low"], "close": c["close"], "volume": c.get("volume") or 0}
        else:
            b["high"] = max(b["high"], c["high"])
            b["low"] = min(b["low"], c["low"])
            b["close"] = c["close"]
            b["volume"] += c.get("volume") or 0
    return [bloques[k] for k in sorted(bloques)]


def _agrupar_desde_m5(m5, horas):
    """Agrupa velas de 5 min en velas de N horas alineadas a la hora en punto."""
    bloques = {}
    for c in m5:
        dt = datetime.utcfromtimestamp(c["time"])  # epoch 'naive' = hora de mercado
        h = (dt.hour // horas) * horas
        clave = dt.replace(hour=h, minute=0, second=0, microsecond=0)
        ts = int(clave.replace(tzinfo=timezone.utc).timestamp())
        b = bloques.get(ts)
        if b is None:
            bloques[ts] = {"time": ts, "open": c["open"], "high": c["high"],
                           "low": c["low"], "close": c["close"], "volume": c.get("volume") or 0}
        else:
            b["high"] = max(b["high"], c["high"])
            b["low"] = min(b["low"], c["low"])
            b["close"] = c["close"]
            b["volume"] += c.get("volume") or 0
    return [bloques[k] for k in sorted(bloques)]


async def _ensure_candles(symbol: str, interval: str, refresh: bool = False):
    """Refresca la caché de velas si hace falta y devuelve las velas guardadas.
    Con mercado abierto la vela en curso se refresca con más frecuencia."""
    # 1H y 4H se realinean a la hora en punto reagrupando desde M5. Como M5 solo cubre
    # ~2 meses, el histórico anterior se conserva tal cual lo entrega el proveedor
    # (alineado a la apertura) y se empalma con el tramo reciente ya realineado.
    if interval in AGREGADAS_MIN:
        m1 = await _ensure_candles_raw(symbol, "m1", refresh)
        return _agrupar_minutos(m1, AGREGADAS_MIN[interval])

    # M30 sale de M15: el proveedor no lo sirve y desde M1 el histórico sería corto
    if interval in AGREGADAS_DESDE_M15:
        m15 = await _ensure_candles_raw(symbol, "m15", refresh)
        return _agrupar_desde_m15(m15, AGREGADAS_DESDE_M15[interval])

    if interval in AGREGADAS:
        base = await _ensure_candles_raw(symbol, interval, refresh)
        try:
            m5 = await _ensure_candles_raw(symbol, "m5", refresh)
        except Exception:
            return base
        if not m5:
            return base
        recientes = _agrupar_desde_m5(m5, AGREGADAS[interval])
        if not recientes:
            return base
        corte = recientes[0]["time"]
        return [c for c in base if c["time"] < corte] + recientes

    return await _ensure_candles_raw(symbol, interval, refresh)


async def _completar_historico(symbol: str, interval: str):
    """Descarga el histórico completo de un símbolo recién estrenado.

    Corre en segundo plano: el gráfico ya se ve con el tramo corto y las velas
    antiguas van apareciendo al desplazarse hacia atrás.
    """
    try:
        rows = await td.fetch_time_series(_api_key(), symbol, interval)
        if rows:
            db.upsert_candles(symbol, interval, rows)
    except Exception:
        pass  # se reintentará en la próxima carga del símbolo


async def _ensure_candles_raw(symbol: str, interval: str, refresh: bool = False):
    """Velas tal como las entrega el proveedor (sin realinear)."""

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
            # Símbolo nuevo: se trae primero un tramo corto para poder pintar ya,
            # y el histórico completo se completa después sin bloquear la respuesta.
            primera_vez = not existing
            rows = await td.fetch_time_series(_api_key(), symbol, interval, start_ts,
                                              rapido=primera_vez)
            if rows:
                db.upsert_candles(symbol, interval, rows)
            db.set_fetch_time(symbol, interval, now)
            if primera_vez:
                asyncio.create_task(_completar_historico(symbol, interval))
        except td.TwelveDataError as e:
            # Twelve Data caído o sin cuota: FMP cubre el diario, que es lo que
            # su plan permite. El intradía se queda con lo que haya en caché.
            rescatado = False
            if interval in fmp.SOPORTA:
                try:
                    rows = await fmp.fetch_daily(fmp.api_key(db), symbol)
                    if rows:
                        db.upsert_candles(symbol, interval, rows)
                        db.set_fetch_time(symbol, interval, now)
                        rescatado = True
                except Exception as fe:
                    print(f"[fmp] respaldo falló para {symbol}/{interval}: {fe}")
            if not rescatado:
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
EXT_CACHE_TTL = {"m2": 60, "m5": 90, "m15": 120, "m30": 240, "1h": 480}


@app.get("/api/candles-ext/{symbol}/{interval}")
async def get_candles_ext(symbol: str, interval: str, refresh: bool = False):
    """Velas intradía con sesión extendida (pre + post), como TC2000 con 'ext' activado."""
    symbol = symbol.upper()
    if interval not in md.EXT_INTERVAL:
        raise HTTPException(400, "Sesión extendida no disponible en esta temporalidad")
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
        # sin cuota en Twelve Data, FMP sí sirve la cotización en vivo
        try:
            q = await fmp.fetch_quote(fmp.api_key(db), symbol.upper())
            if q and q.get("price") is not None:
                return {"symbol": symbol.upper(), "price": q["price"], "fuente": "fmp"}
        except Exception:
            pass
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


# Histórico del precio objetivo por símbolo, para detectar cambios entre sesiones.
TARGET_HIST_KEY = "target_hist"
TARGET_LOG_KEY = "target_log"   # registro acumulado de todos los cambios
TARGET_LOG_MAX = 400            # se conservan los más recientes
AVISO_DIAS = 14  # antigüedad máxima de un cambio para seguir avisando


def _target_log() -> list:
    try:
        return json.loads(db.get_setting(TARGET_LOG_KEY) or "[]")
    except Exception:
        return []


def _target_hist() -> dict:
    try:
        return json.loads(db.get_setting(TARGET_HIST_KEY) or "{}")
    except Exception:
        return {}


def _guardar_target(symbol: str, data: dict | None):
    """Anota el objetivo actual y, si cambió, cuándo y desde qué valor."""
    if not data or data.get("average") is None:
        return
    hist = _target_hist()
    previo = hist.get(symbol)
    nuevo = round(float(data["average"]), 2)
    hoy = datetime.now(saltos.MARKET_TZ).date().isoformat()
    if previo and previo.get("valor") is not None and abs(previo["valor"] - nuevo) > 0.005:
        hist[symbol] = {"valor": nuevo, "anterior": previo["valor"],
                        "cambio": hoy, "updated": data.get("updated")}
        # el histórico guarda solo el último cambio de cada activo; el registro
        # acumula todos para poder consultarlos después
        log = _target_log()
        log.append({"symbol": symbol, "valor": nuevo, "anterior": previo["valor"],
                    "fecha": hoy, "updated": data.get("updated"),
                    "ts": int(time.time())})
        db.set_setting(TARGET_LOG_KEY, json.dumps(log[-TARGET_LOG_MAX:]))
    elif not previo:
        hist[symbol] = {"valor": nuevo, "anterior": None, "cambio": None,
                        "updated": data.get("updated")}
    else:
        return  # sin cambios: no se reescribe
    db.set_setting(TARGET_HIST_KEY, json.dumps(hist))


@app.get("/api/avisos")
async def avisos_inicio():
    """Avisos para el modal de bienvenida: cambios recientes de precio objetivo."""
    hist = _target_hist()
    tickers = _watchlist_tickers()
    # se refrescan los objetivos para detectar cambios desde la última sesión
    for t in tickers:
        try:
            cached = _target_cache.get(t)
            if cached and (time.time() - cached[0]) < TARGET_CACHE_TTL:
                data = cached[1]
            else:
                data = await tp.fetch_target_price(t)
                _target_cache[t] = (time.time(), data)
            _guardar_target(t, data)
        except Exception:
            pass

    hist = _target_hist()
    limite = (datetime.now(saltos.MARKET_TZ).date() - timedelta(days=AVISO_DIAS)).isoformat()
    cambios = [
        {"symbol": t, "valor": h["valor"], "anterior": h["anterior"],
         "fecha": h["cambio"], "updated": h.get("updated")}
        for t, h in hist.items()
        if t in tickers and h.get("cambio") and h["cambio"] >= limite
    ]
    cambios.sort(key=lambda c: c["fecha"], reverse=True)
    return {"targets": cambios}


@app.get("/api/target-log")
def historial_targets(limit: int = 200):
    """Registro de todos los cambios de precio objetivo detectados."""
    log = _target_log()
    tickers = set(_watchlist_tickers())
    filas = [r for r in log if r["symbol"] in tickers]
    filas.sort(key=lambda r: (r.get("ts") or 0, r["fecha"]), reverse=True)
    return {"items": filas[:limit]}


@app.delete("/api/target-log/{ts}")
def borrar_target_log(ts: int, symbol: str):
    """Elimina un cambio concreto del registro (por su marca de tiempo)."""
    log = _target_log()
    quedan = [r for r in log if not (r.get("ts") == ts and r["symbol"] == symbol.upper())]
    if len(quedan) == len(log):
        raise HTTPException(404, "Ese cambio ya no está en el registro")
    db.set_setting(TARGET_LOG_KEY, json.dumps(quedan))
    return {"ok": True, "restantes": len(quedan)}


@app.get("/api/fomc")
async def proxima_fomc():
    """Fecha de la próxima decisión de tipos del FOMC."""
    try:
        return await fomc.proxima_reunion() or {}
    except Exception:
        return {}


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
    _guardar_target(symbol, data)
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


# ---------------- Escáner de toques a la MA20 y cruces de medias ----------------

_toques_state = {"running": False, "done": 0, "total": 0, "updated_at": None}


TOQUES_TFS = (("m15", "M15"), ("1h", "1H"), ("1d", "D1"))


@app.get("/api/toques")
async def escanear_toques(solo: str = "", todos: bool = False):
    """Rejilla de tendencia por temporalidad, con los toques a la MA20 y los
    cruces de medias (20/40 y 100/200) de cada activo de la lista."""
    if _toques_state["running"]:
        return {"running": True, "items": [], "status": dict(_toques_state)}
    # Cada escaneo cuesta 3 llamadas al proveedor por activo, y el plan gratuito
    # da 800 al día: por defecto se recorren solo los favoritos que envía el
    # navegador, y con todos=1 se fuerza la lista completa.
    tickers = _watchlist_tickers()
    if not todos and solo:
        pedidos = {t.strip().upper() for t in solo.split(",") if t.strip()}
        elegidos = [t for t in tickers if t in pedidos]
        if elegidos:
            tickers = elegidos
    _toques_state.update(running=True, done=0, total=len(tickers))
    items = []
    try:
        for t in tickers:
            try:
                celdas, cruces, h1 = {}, [], None
                for tf, etiqueta in TOQUES_TFS:
                    # cada temporalidad falla por su cuenta: si el proveedor
                    # corta por límite de peticiones, la celda queda vacía pero
                    # el resto de la fila se conserva
                    try:
                        velas = await _ensure_candles(t, tf)
                    except Exception:
                        celdas[etiqueta] = {"estado": None, "toques": 0, "excelentes": 0,
                                            "buenos": 0, "ultimo_velas_atras": None,
                                            "ultima_media": None, "por_media": {},
                                            "reciente": None}
                        continue
                    if tf == "1h":
                        h1 = velas
                    res = tq.detectar_rebotes(velas)
                    # el rebote más nuevo es lo accionable: qué media y hace cuánto
                    ultimo = (res or {}).get("rebotes", [])[-1:] or [None]
                    celdas[etiqueta] = {
                        "estado": tq.estado_tendencia(velas),
                        "toques": (res or {}).get("total") or 0,
                        "excelentes": (res or {}).get("excelentes") or 0,
                        "buenos": (res or {}).get("buenos") or 0,
                        "ultimo_velas_atras": (res or {}).get("ultimo_velas_atras"),
                        "ultima_media": (res or {}).get("ultima_media"),
                        "por_media": (res or {}).get("por_media") or {},
                        "reciente": ultimo[0],
                    }
                    for c in tq.detectar_cruces(velas):
                        cruces.append({**c, "tf": etiqueta})

                res_h1 = tq.detectar_rebotes(h1) if h1 else None
                # señal en vivo: está apoyándose otra vez en la MA20 de 1H
                segundo = tq.segundo_toque(h1) if h1 else None
                alineados = sum(1 for c in celdas.values() if c["estado"] in ("up", "down"))
                estados = {c["estado"] for c in celdas.values() if c["estado"] in ("up", "down")}
                items.append({
                    "symbol": t,
                    "celdas": celdas,
                    "segundo": segundo,
                    "toques": res_h1,
                    "cruces": cruces,
                    "alineados": alineados,
                    # todas las temporalidades activas apuntan al mismo lado
                    "pleno": len(estados) == 1 and alineados == len(TOQUES_TFS),
                })
            except Exception:
                pass
            _toques_state["done"] += 1
    finally:
        _toques_state["running"] = False
        _toques_state["updated_at"] = datetime.now(saltos.MARKET_TZ).strftime("%H:%M:%S ET")

    # Arriba lo accionable: quien acaba de rebotar. Se mide por la celda con el
    # rebote más fresco, dando prioridad a los excelentes y a las medias mayores
    # (rebotar en la 200 pesa más que en la 20).
    def frescura(item):
        mejor = None
        for celda in item["celdas"].values():
            r = celda.get("reciente")
            if not r:
                continue
            rank = (r["velas_atras"], 0 if r["calidad"] == "excelente" else 1, -r["media"])
            if mejor is None or rank < mejor:
                mejor = rank
        return mejor or (9999, 9, 0)

    items.sort(key=lambda x: (
        0 if x.get("segundo") else 1,                     # tocando ahora, arriba
        (x.get("segundo") or {}).get("velas_atras", 99),  # el más fresco primero
        frescura(x),
        -x["alineados"],
    ))
    return {"running": False, "items": items, "status": dict(_toques_state)}


# ---------------- Rango de precios (cadena de opciones) ----------------

class RangoIn(BaseModel):
    symbol: str
    kind: str = "call"  # 'call' | 'put'
    min_price: float | None = None
    max_price: float | None = None
    count: int | None = None


def _rango_opts(body: RangoIn):
    """Ajustes efectivos: los del cuerpo o los guardados por el usuario."""
    if body.kind not in ("call", "put"):
        raise HTTPException(400, "kind debe ser 'call' o 'put'")
    cfg = _get_rangos_config()
    min_price = body.min_price if body.min_price is not None else cfg["min_price"]
    max_price = body.max_price if body.max_price is not None else cfg["max_price"]
    count = body.count if body.count is not None else cfg["count"]
    if min_price < 0 or max_price <= min_price or count < 1 or count > 100:
        raise HTTPException(400, "Ajustes inválidos (0 ≤ mínimo < máximo, cantidad entre 1 y 100)")
    return min_price, max_price, count


class RangosConfigIn(BaseModel):
    min_price: float
    max_price: float
    count: int


def _get_rangos_config():
    try:
        cfg = json.loads(db.get_setting("rangos_config", "") or "{}")
    except (ValueError, TypeError):
        cfg = {}
    return {
        "min_price": float(cfg.get("min_price", rangos.DEFAULT_MIN_PRICE)),
        "max_price": float(cfg.get("max_price", rangos.DEFAULT_MAX_PRICE)),
        "count": int(cfg.get("count", rangos.DEFAULT_COUNT)),
    }


@app.get("/api/rangos/config")
def get_rangos_config():
    return _get_rangos_config()


@app.post("/api/rangos/config")
def set_rangos_config(body: RangosConfigIn):
    if body.min_price < 0 or body.max_price <= body.min_price or body.count < 1 or body.count > 100:
        raise HTTPException(400, "Ajustes inválidos (0 ≤ mínimo < máximo, cantidad entre 1 y 100)")
    db.set_setting("rangos_config", json.dumps(
        {"min_price": body.min_price, "max_price": body.max_price, "count": body.count}))
    return _get_rangos_config()


@app.post("/api/rangos/calcular")
async def calcular_rango(body: RangoIn):
    """Calcula el rango SIN guardarlo (vista previa)."""
    min_price, max_price, count = _rango_opts(body)
    try:
        return await rangos.calculate(body.symbol.strip().upper(), body.kind, min_price, max_price, count)
    except rangos.RangosError as e:
        raise HTTPException(502, str(e))


@app.post("/api/rangos")
async def guardar_rango(body: RangoIn):
    """Calcula y guarda el cálculo completo en la base de datos."""
    min_price, max_price, count = _rango_opts(body)
    try:
        calc = await rangos.calculate(body.symbol.strip().upper(), body.kind, min_price, max_price, count)
    except rangos.RangosError as e:
        raise HTTPException(502, str(e))
    rid = db.add_rango(calc["symbol"], calc["kind"], calc["expiration"], calc["spot"],
                       calc["direction"], calc["change_pct"], calc,
                       calc.get("range_min"), calc.get("range_max"))
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
