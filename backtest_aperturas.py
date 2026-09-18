"""Backtest del escáner de aperturas fuera de las Bandas de Bollinger.

Recorre todo el histórico guardado y busca los días en que un activo abrió fuera
de las bandas en D1, 1H y M15 a la vez, con la separación mínima que exige el
escáner. Después mide qué hizo el precio ese mismo día, para saber si la señal
anticipa algo.

Lee de SQLite, así que no gasta cuota del proveedor.
"""
import sys
import datetime
from collections import defaultdict

sys.path.insert(0, '.')
from server import db, aperturas as ap


def candles(sym, tf):
    """Velas guardadas, con la clave 'time' que espera el detector."""
    return db.get_candles(sym, tf)


def dias_de(velas):
    return sorted({ap._dia(c["time"]) for c in velas})


def recorrido_del_dia(m15, dia, direccion):
    """Qué hizo el precio desde la apertura hasta el cierre de esa sesión."""
    sesion = [c for c in m15 if ap._dia(c["time"]) == dia]
    if not sesion:
        return None
    apertura = sesion[0]["open"]
    cierre = sesion[-1]["close"]
    maximo = max(c["high"] for c in sesion)
    minimo = min(c["low"] for c in sesion)
    # a favor: en alcista lo que subió; en bajista lo que bajó
    if direccion == "alcista":
        favor = (maximo / apertura - 1) * 100
        contra = (minimo / apertura - 1) * 100
        cierre_pct = (cierre / apertura - 1) * 100
    else:
        favor = (1 - minimo / apertura) * 100
        contra = (1 - maximo / apertura) * 100
        cierre_pct = (1 - cierre / apertura) * 100
    return {"favor": favor, "contra": contra, "cierre": cierre_pct}


def main():
    tickers = [s["ticker"] for g in db.get_watchlist() for s in g["symbols"]]
    print(f"BACKTEST · aperturas fuera de bandas · umbral {ap.SEPARACION_MIN_PCT}%")
    print(f"activos en la lista: {len(tickers)}")
    print()

    señales = []
    sin_datos = []
    revisadas = 0

    for t in tickers:
        vel = {tf: candles(t, tf) for tf in ap.TEMPORALIDADES}
        if not all(vel.values()):
            sin_datos.append(t)
            continue
        for d in dias_de(vel["m15"]):
            revisadas += 1
            res = {}
            for tf in ap.TEMPORALIDADES:
                r = ap.evaluar_apertura(vel[tf], tf, d)
                if not r:
                    break
                res[tf] = r
            if len(res) != len(ap.TEMPORALIDADES):
                continue
            if len({r["direccion"] for r in res.values()}) != 1:
                continue
            direccion = res["1d"]["direccion"]
            rec = recorrido_del_dia(vel["m15"], d, direccion)
            if rec:
                señales.append({"symbol": t, "dia": d, "direccion": direccion,
                                "res": res, **rec})

    print(f"aperturas revisadas: {revisadas}")
    print(f"activos sin datos completos: {len(sin_datos)}"
          + (f" ({', '.join(sin_datos[:8])}…)" if sin_datos else ""))
    print(f"SEÑALES ENCONTRADAS: {len(señales)}")
    print()

    if not señales:
        return

    # ---- resultado ----
    for direccion in ("alcista", "bajista"):
        g = [s for s in señales if s["direccion"] == direccion]
        if not g:
            continue
        aciertos = [s for s in g if s["cierre"] > 0]
        print(f"--- {direccion.upper()} ({len(g)} señales) ---")
        print(f"  cerró a favor       : {len(aciertos)}/{len(g)}  ({len(aciertos)/len(g)*100:.0f}%)")
        print(f"  recorrido a favor   : {sum(s['favor'] for s in g)/len(g):+.2f}% de media (máximo del día)")
        print(f"  recorrido en contra : {sum(s['contra'] for s in g)/len(g):+.2f}% de media")
        print(f"  cierre del día      : {sum(s['cierre'] for s in g)/len(g):+.2f}% de media")
        print()

    print("=== TODAS LAS SEÑALES ===")
    print(f"{'fecha':9s} {'activo':6s} {'dir':9s} {'D1':>7s} {'1H':>7s} {'M15':>7s}"
          f" {'max':>7s} {'min':>7s} {'cierre':>7s}")
    for s in sorted(señales, key=lambda x: x["dia"]):
        f = str(s["dia"])
        r = s["res"]
        print(f"{f[6:8]}/{f[4:6]}/{f[2:4]} {s['symbol']:6s} {s['direccion']:9s}"
              f" {r['1d']['distancia_pct']:6.2f}% {r['1h']['distancia_pct']:6.2f}%"
              f" {r['m15']['distancia_pct']:6.2f}%"
              f" {s['favor']:+6.2f}% {s['contra']:+6.2f}% {s['cierre']:+6.2f}%")


main()
