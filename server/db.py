"""Capa de datos: SQLite local en data/acciones.db"""
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "acciones.db"

# La clave real se configura desde la UI (Configuración > API key) y queda guardada en
# data/acciones.db (no versionado). TWELVEDATA_API_KEY es solo un valor semilla opcional.
DEFAULT_API_KEY = os.environ.get("TWELVEDATA_API_KEY", "")

DEFAULT_MA_CONFIG = [
    {"enabled": True, "type": "SMA", "period": 20, "color": "#facc15", "width": 1},   # amarilla
    {"enabled": True, "type": "SMA", "period": 40, "color": "#ef4444", "width": 1},   # roja
    {"enabled": True, "type": "SMA", "period": 100, "color": "#39ff14", "width": 3},  # verde fosforescente
    {"enabled": True, "type": "SMA", "period": 200, "color": "#a855f7", "width": 3},  # morada
]

SEED_WATCHLIST = [
    ("Tecnología", [
        ("META", "Meta Platforms"), ("AAPL", "Apple"), ("NVDA", "NVIDIA"),
        ("AMD", "AMD"), ("MU", "Micron"), ("TSLA", "Tesla"),
        ("NFLX", "Netflix"), ("AMZN", "Amazon"),
    ]),
    ("ETFs Índices", [
        ("SPY", "S&P 500 ETF"), ("QQQ", "Nasdaq 100 ETF"),
    ]),
    ("Materias Primas", [
        ("SLV", "iShares Silver"), ("GLD", "SPDR Gold"), ("USO", "US Oil Fund"),
    ]),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    name TEXT DEFAULT '',
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL,
    PRIMARY KEY (symbol, interval, ts)
);
CREATE TABLE IF NOT EXISTS fetch_log (
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (symbol, interval)
);
CREATE TABLE IF NOT EXISTS drawings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS alarms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    direction TEXT NOT NULL,
    note TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    triggered_at TEXT,
    triggered_price REAL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS ma_config (
    scope TEXT PRIMARY KEY,
    config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS earnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'reportado',
    time_of_day TEXT NOT NULL DEFAULT '',
    eps_estimate REAL,
    eps_actual REAL,
    note TEXT DEFAULT '',
    UNIQUE(symbol, date)
);
"""


@contextmanager
def connect():
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with connect() as conn:
        conn.executescript(SCHEMA)
        earnings_cols = {r["name"] for r in conn.execute("PRAGMA table_info(earnings)")}
        if "time_of_day" not in earnings_cols:
            conn.execute("ALTER TABLE earnings ADD COLUMN time_of_day TEXT NOT NULL DEFAULT ''")
        if conn.execute("SELECT COUNT(*) c FROM settings WHERE key='api_key'").fetchone()["c"] == 0:
            conn.execute("INSERT INTO settings (key, value) VALUES ('api_key', ?)", (DEFAULT_API_KEY,))
        if conn.execute("SELECT COUNT(*) c FROM ma_config WHERE scope='global'").fetchone()["c"] == 0:
            conn.execute("INSERT INTO ma_config (scope, config) VALUES ('global', ?)",
                         (json.dumps(DEFAULT_MA_CONFIG),))
        if conn.execute("SELECT COUNT(*) c FROM settings WHERE key='ma_defaults_v2'").fetchone()["c"] == 0:
            conn.execute("UPDATE ma_config SET config=? WHERE scope='global'", (json.dumps(DEFAULT_MA_CONFIG),))
            conn.execute("INSERT INTO settings (key, value) VALUES ('ma_defaults_v2', '1')")
        if conn.execute("SELECT COUNT(*) c FROM settings WHERE key='ma_defaults_v3'").fetchone()["c"] == 0:
            conn.execute("UPDATE ma_config SET config=? WHERE scope='global'", (json.dumps(DEFAULT_MA_CONFIG),))
            conn.execute("INSERT INTO settings (key, value) VALUES ('ma_defaults_v3', '1')")
        if conn.execute("SELECT COUNT(*) c FROM groups").fetchone()["c"] == 0:
            for gpos, (gname, syms) in enumerate(SEED_WATCHLIST):
                cur = conn.execute("INSERT INTO groups (name, position) VALUES (?, ?)", (gname, gpos))
                gid = cur.lastrowid
                for spos, (ticker, name) in enumerate(syms):
                    conn.execute(
                        "INSERT INTO symbols (ticker, name, group_id, position) VALUES (?, ?, ?, ?)",
                        (ticker, name, gid, spos))


# ---------- settings ----------

def get_setting(key, default=None):
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key, value):
    with connect() as conn:
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


# ---------- watchlist ----------

def get_watchlist():
    with connect() as conn:
        groups = [dict(r) for r in conn.execute(
            "SELECT id, name, position FROM groups ORDER BY position, id")]
        for g in groups:
            g["symbols"] = [dict(r) for r in conn.execute(
                "SELECT id, ticker, name, position FROM symbols WHERE group_id=? ORDER BY position, id",
                (g["id"],))]
        return groups


def add_group(name):
    with connect() as conn:
        pos = conn.execute("SELECT COALESCE(MAX(position),-1)+1 p FROM groups").fetchone()["p"]
        cur = conn.execute("INSERT INTO groups (name, position) VALUES (?, ?)", (name, pos))
        return cur.lastrowid


def rename_group(gid, name):
    with connect() as conn:
        conn.execute("UPDATE groups SET name=? WHERE id=?", (name, gid))


def delete_group(gid):
    with connect() as conn:
        conn.execute("DELETE FROM groups WHERE id=?", (gid,))


def add_symbol(ticker, name, group_id):
    with connect() as conn:
        dup = conn.execute("SELECT id FROM symbols WHERE ticker=? AND group_id=?",
                           (ticker, group_id)).fetchone()
        if dup:
            return dup["id"]
        pos = conn.execute("SELECT COALESCE(MAX(position),-1)+1 p FROM symbols WHERE group_id=?",
                           (group_id,)).fetchone()["p"]
        cur = conn.execute("INSERT INTO symbols (ticker, name, group_id, position) VALUES (?, ?, ?, ?)",
                           (ticker, name, group_id, pos))
        return cur.lastrowid


def delete_symbol(sid):
    with connect() as conn:
        conn.execute("DELETE FROM symbols WHERE id=?", (sid,))


def move_symbol(sid, group_id):
    with connect() as conn:
        pos = conn.execute("SELECT COALESCE(MAX(position),-1)+1 p FROM symbols WHERE group_id=?",
                           (group_id,)).fetchone()["p"]
        conn.execute("UPDATE symbols SET group_id=?, position=? WHERE id=?", (group_id, pos, sid))


# ---------- candles ----------

def get_candles(symbol, interval):
    with connect() as conn:
        rows = conn.execute(
            "SELECT ts, open, high, low, close, volume FROM candles "
            "WHERE symbol=? AND interval=? ORDER BY ts", (symbol, interval))
        return [{"time": r["ts"], "open": r["open"], "high": r["high"],
                 "low": r["low"], "close": r["close"], "volume": r["volume"]} for r in rows]


def upsert_candles(symbol, interval, rows):
    with connect() as conn:
        conn.executemany(
            "INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(symbol, interval, ts) DO UPDATE SET "
            "open=excluded.open, high=excluded.high, low=excluded.low, "
            "close=excluded.close, volume=excluded.volume",
            [(symbol, interval, r["ts"], r["open"], r["high"], r["low"], r["close"], r["volume"])
             for r in rows])


def get_fetch_time(symbol, interval):
    with connect() as conn:
        row = conn.execute("SELECT fetched_at FROM fetch_log WHERE symbol=? AND interval=?",
                           (symbol, interval)).fetchone()
        return row["fetched_at"] if row else 0


def set_fetch_time(symbol, interval, ts):
    with connect() as conn:
        conn.execute("INSERT INTO fetch_log (symbol, interval, fetched_at) VALUES (?, ?, ?) "
                     "ON CONFLICT(symbol, interval) DO UPDATE SET fetched_at=excluded.fetched_at",
                     (symbol, interval, ts))


# ---------- earnings (registro manual, editable por el usuario) ----------

def get_earnings(symbol):
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, symbol, date, ts, status, time_of_day, eps_estimate, eps_actual, note FROM earnings "
            "WHERE symbol=? ORDER BY ts DESC", (symbol,))
        return [dict(r) for r in rows]


def add_earnings(symbol, date, ts, status, time_of_day, eps_estimate, eps_actual, note):
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO earnings (symbol, date, ts, status, time_of_day, eps_estimate, eps_actual, note) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(symbol, date) DO UPDATE SET "
            "status=excluded.status, time_of_day=excluded.time_of_day, eps_estimate=excluded.eps_estimate, "
            "eps_actual=excluded.eps_actual, note=excluded.note",
            (symbol, date, ts, status, time_of_day, eps_estimate, eps_actual, note))
        return cur.lastrowid


def delete_earnings(eid):
    with connect() as conn:
        conn.execute("DELETE FROM earnings WHERE id=?", (eid,))


def get_next_earnings_all(now_ts):
    with connect() as conn:
        rows = conn.execute(
            "SELECT symbol, date, status, time_of_day, MIN(ts) FROM earnings WHERE ts > ? GROUP BY symbol",
            (now_ts,))
        return {r["symbol"]: {"date": r["date"], "status": r["status"], "time_of_day": r["time_of_day"]} for r in rows}


# ---------- drawings (líneas de tendencia) ----------

def get_drawings(symbol, interval):
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, symbol, interval, type, data, created_at FROM drawings "
            "WHERE symbol=? AND interval=? ORDER BY id", (symbol, interval))
        return [{**dict(r), "data": json.loads(r["data"])} for r in rows]


def add_drawing(symbol, interval, dtype, data):
    with connect() as conn:
        cur = conn.execute("INSERT INTO drawings (symbol, interval, type, data) VALUES (?, ?, ?, ?)",
                           (symbol, interval, dtype, json.dumps(data)))
        return cur.lastrowid


def update_drawing(did, data):
    with connect() as conn:
        conn.execute("UPDATE drawings SET data=? WHERE id=?", (json.dumps(data), did))


def delete_drawing(did):
    with connect() as conn:
        conn.execute("DELETE FROM drawings WHERE id=?", (did,))


# ---------- notes ----------

def get_notes(symbol):
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, symbol, text, created_at, updated_at FROM notes "
            "WHERE symbol=? ORDER BY id DESC", (symbol,))
        return [dict(r) for r in rows]


def add_note(symbol, text):
    with connect() as conn:
        cur = conn.execute("INSERT INTO notes (symbol, text) VALUES (?, ?)", (symbol, text))
        return cur.lastrowid


def update_note(nid, text):
    with connect() as conn:
        conn.execute("UPDATE notes SET text=?, updated_at=datetime('now','localtime') WHERE id=?",
                     (text, nid))


def delete_note(nid):
    with connect() as conn:
        conn.execute("DELETE FROM notes WHERE id=?", (nid,))


# ---------- alarms ----------

def get_alarms(symbol=None):
    with connect() as conn:
        if symbol:
            rows = conn.execute("SELECT * FROM alarms WHERE symbol=? ORDER BY id DESC", (symbol,))
        else:
            rows = conn.execute("SELECT * FROM alarms ORDER BY id DESC")
        return [dict(r) for r in rows]


def get_active_alarms():
    with connect() as conn:
        rows = conn.execute("SELECT * FROM alarms WHERE active=1 AND triggered_at IS NULL")
        return [dict(r) for r in rows]


def add_alarm(symbol, price, direction, note=""):
    with connect() as conn:
        cur = conn.execute("INSERT INTO alarms (symbol, price, direction, note) VALUES (?, ?, ?, ?)",
                           (symbol, price, direction, note))
        return cur.lastrowid


def trigger_alarm(aid, price):
    with connect() as conn:
        conn.execute("UPDATE alarms SET active=0, triggered_at=datetime('now','localtime'), "
                     "triggered_price=? WHERE id=?", (price, aid))


def reactivate_alarm(aid):
    with connect() as conn:
        conn.execute("UPDATE alarms SET active=1, triggered_at=NULL, triggered_price=NULL WHERE id=?",
                     (aid,))


def delete_alarm(aid):
    with connect() as conn:
        conn.execute("DELETE FROM alarms WHERE id=?", (aid,))


# ---------- ma config ----------

def get_ma_config(symbol=None):
    with connect() as conn:
        if symbol:
            row = conn.execute("SELECT config FROM ma_config WHERE scope=?", (symbol,)).fetchone()
            if row:
                return {"scope": symbol, "config": json.loads(row["config"])}
        row = conn.execute("SELECT config FROM ma_config WHERE scope='global'").fetchone()
        config = json.loads(row["config"]) if row else DEFAULT_MA_CONFIG
        return {"scope": "global", "config": config}


def set_ma_config(scope, config):
    with connect() as conn:
        conn.execute("INSERT INTO ma_config (scope, config) VALUES (?, ?) "
                     "ON CONFLICT(scope) DO UPDATE SET config=excluded.config",
                     (scope, json.dumps(config)))


def delete_ma_config(scope):
    with connect() as conn:
        conn.execute("DELETE FROM ma_config WHERE scope=? AND scope != 'global'", (scope,))
