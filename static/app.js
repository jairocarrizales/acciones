/* Plataforma de Acciones — frontend */
(function () {
"use strict";

const state = {
  symbol: "META",
  theme: localStorage.getItem("theme") || "dark",
  maConfig: [],
  maScope: "global",
  alarms: [],
  earnings: [],
  nextEarningsMap: {},
  trendScan: {},
  news: [],
  targetPrice: null,
  dailyCandles: [], // referencia D1 para mostrar el nivel de sus MAs en paneles intradía
};

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${d} ${MONTHS_ES[m - 1]}`;
}

document.documentElement.setAttribute("data-theme", state.theme);

function updateThemeIcon() {
  const icon = document.getElementById("themeIcon");
  icon.className = "fa-solid " + (state.theme === "dark" ? "fa-moon" : "fa-sun");
}

// ---------------- helpers ----------------

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

function toast(message, isAlarm, icon) {
  const host = document.getElementById("toastHost");
  const el = document.createElement("div");
  el.className = "toast" + (isAlarm ? " alarm" : "");
  if (icon) {
    const i = document.createElement("i");
    i.className = "fa-solid " + icon;
    el.appendChild(i);
    el.appendChild(document.createTextNode(" " + message));
  } else {
    el.textContent = message;
  }
  host.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    o.start();
    o.stop(ctx.currentTime + 0.6);
  } catch (_) {}
}

function notifyBrowser(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission();
  }
}

// ---------------- theme ----------------

document.getElementById("btnTheme").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem("theme", state.theme);
  updateThemeIcon();
  applyChartTheme();
});

// ---------------- chart setup (dos paneles independientes) ----------------

// ---------------- personalización local (por navegador / PC de cada usuario) ----------------
// Favoritos, corazones de saltos y líneas de tendencia se guardan en localStorage,
// así cada persona que abre el portal desde su PC tiene su propia personalización.

function localGet(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (_) { return fallback; }
}
function localSet(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const getLocalFavs = () => localGet("favTickers", []);
const setLocalFavs = (a) => localSet("favTickers", a);
const getLocalHearts = () => localGet("saltosHeartsLocal", []);
const setLocalHearts = (a) => localSet("saltosHeartsLocal", a);
// Los dibujos se guardan POR SÍMBOLO (no por temporalidad): una línea trazada en
// una temporalidad se ve también en la otra pantalla y en cualquier temporalidad.
const symbolDrawingsKey = (sym) => `drawings2:${sym}`;
const getSymbolDrawings = (sym) => localGet(symbolDrawingsKey(sym), []);
const setSymbolDrawings = (sym, arr) => localSet(symbolDrawingsKey(sym), arr);

function nextDrawingId() {
  const n = (parseInt(localStorage.getItem("drawingSeq") || "0", 10) || 0) + 1;
  localStorage.setItem("drawingSeq", String(n));
  return n;
}

// Color de dibujo preferido (local por navegador). Debe declararse antes de crear
// los paneles, porque setupDrawingTool construye la paleta al inicializar.
const DRAW_COLORS = ["#2962ff", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ffffff"];
const getDrawColor = () => localStorage.getItem("drawColor") || DRAW_COLORS[0];
const setDrawColorPref = (c) => localStorage.setItem("drawColor", c);

// Migración v2: fusiona las claves antiguas por símbolo+temporalidad en una sola por símbolo.
function migrateDrawingsV2() {
  if (localStorage.getItem("localDrawingsV2")) return;
  const merged = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("drawings:")) continue;
    const sym = k.split(":")[1];
    (merged[sym] = merged[sym] || []).push(...localGet(k, []));
  }
  Object.entries(merged).forEach(([sym, arr]) => {
    if (!localStorage.getItem(symbolDrawingsKey(sym))) {
      setSymbolDrawings(sym, arr.map((d) => ({ type: d.type || "trend", ...d })));
    }
  });
  localStorage.setItem("localDrawingsV2", "1");
}
migrateDrawingsV2();

// Importación única desde el servidor: los favoritos/líneas/corazones que existían
// antes de que la personalización pasara a ser local se copian la primera vez que
// este navegador abre el portal (después, cada navegador va por su cuenta).
async function migrateLocalPersonalization(groups) {
  if (localStorage.getItem("localPersonalizationV1")) return;
  const favs = [];
  (groups || []).forEach((g) => g.symbols.forEach((s) => { if (s.favorite) favs.push(s.ticker); }));
  if (favs.length && !getLocalFavs().length) setLocalFavs(favs);
  try {
    const all = await api("/api/drawings-all");
    const bySym = {};
    all.forEach((d) => {
      (bySym[d.symbol] = bySym[d.symbol] || []).push({ id: nextDrawingId(), type: d.type || "trend", data: d.data });
    });
    Object.entries(bySym).forEach(([sym, arr]) => {
      if (!localStorage.getItem(symbolDrawingsKey(sym))) setSymbolDrawings(sym, arr);
    });
  } catch (_) {}
  try {
    const st = await api("/api/saltos");
    if (st.hearts && st.hearts.length && !getLocalHearts().length) setLocalHearts(st.hearts);
  } catch (_) {}
  localStorage.setItem("localPersonalizationV1", "1");
}

const LC = window.LightweightCharts;

function createPane(letter, defaultInterval) {
  const container = document.getElementById(`chartContainer${letter}`);
  const chart = LC.createChart(container, {
    layout: { background: { color: "transparent" }, textColor: "#8b93a1" },
    grid: {
      vertLines: { color: "rgba(140,150,170,0.08)" },
      horzLines: { color: "rgba(140,150,170,0.08)" },
    },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "rgba(140,150,170,0.2)" },
    rightPriceScale: { borderColor: "rgba(140,150,170,0.2)" },
    crosshair: { mode: LC.CrosshairMode.Normal },
    autoSize: true,
  });

  const candleSeries = chart.addSeries(LC.CandlestickSeries, {
    upColor: "#22c55e", downColor: "#ef4444", borderVisible: false,
    wickUpColor: "#22c55e", wickDownColor: "#ef4444",
  });

  const earningsMarkersPrimitive = LC.createSeriesMarkers(candleSeries, []);

  const pane = {
    letter, container, chart, candleSeries, earningsMarkersPrimitive,
    maSeries: [], maVisible: true, bbSeries: [], bbVisible: false, dailyMaLines: [],
    targetPriceLine: null, alarmPriceLines: [],
    interval: defaultInterval, candles: [],
    trendPrimitives: [], drawings: [], selectedDrawingId: null,
    drawMode: false, pendingPoint: null, previewPrimitive: null,
  };

  // autoSize se encarga del redimensionado; no se re-encuadra el histórico completo
  // para no perder el zoom en lo último del precio.
  return pane;
}

const panes = { A: createPane("A", "1d"), B: createPane("B", "m15") };
Object.values(panes).forEach((p) => setupDrawingTool(p));

function applyChartTheme() {
  const dark = state.theme === "dark";
  const opts = {
    layout: { background: { color: "transparent" }, textColor: dark ? "#8b93a1" : "#475066" },
    grid: {
      vertLines: { color: dark ? "rgba(140,150,170,0.08)" : "rgba(80,90,110,0.10)" },
      horzLines: { color: dark ? "rgba(140,150,170,0.08)" : "rgba(80,90,110,0.10)" },
    },
  };
  Object.values(panes).forEach((p) => p.chart.applyOptions(opts));
}
applyChartTheme();

// ---------------- MA calculation ----------------

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      const slice = values.slice(0, period);
      prev = slice.reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function renderMAs(pane) {
  pane.maSeries.forEach((s) => pane.chart.removeSeries(s));
  pane.maSeries = [];
  if (!pane.candles.length) return;

  const closes = pane.candles.map((c) => c.close);
  const times = pane.candles.map((c) => c.time);

  state.maConfig.forEach((ma) => {
    if (!ma.enabled) return;
    const values = ma.type === "EMA" ? ema(closes, ma.period) : sma(closes, ma.period);
    const data = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null) data.push({ time: times[i], value: values[i] });
    }
    const series = pane.chart.addSeries(LC.LineSeries, {
      color: ma.color, lineWidth: ma.width || 2, visible: pane.maVisible,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    series.setData(data);
    pane.maSeries.push(series);
  });
}

function renderAllMAs() { Object.values(panes).forEach((p) => renderMAs(p)); }

// Referencia fija del nivel de las MAs de D1 en paneles intradía (M15/1H), con línea
// punteada para distinguirlas de las MAs nativas de esa temporalidad.
function applyDailyMaLines(pane) {
  pane.dailyMaLines.forEach((pl) => { try { pane.candleSeries.removePriceLine(pl); } catch (_) {} });
  pane.dailyMaLines = [];
  if (pane.interval === "1d" || !state.dailyCandles.length) return;

  const closes = state.dailyCandles.map((c) => c.close);
  state.maConfig.forEach((ma) => {
    if (!ma.enabled) return;
    const values = ma.type === "EMA" ? ema(closes, ma.period) : sma(closes, ma.period);
    let last = null;
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] !== null) { last = values[i]; break; }
    }
    if (last == null) return;
    const pl = pane.candleSeries.createPriceLine({
      price: last, color: ma.color, lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: pane.maVisible, lineVisible: pane.maVisible,
      title: `D1 ${ma.type}${ma.period}`,
    });
    pane.dailyMaLines.push(pl);
  });
}

function renderAllDailyMaLines() { Object.values(panes).forEach((p) => applyDailyMaLines(p)); }

async function loadDailyReference() {
  try {
    state.dailyCandles = await api(`/api/candles/${state.symbol}/1d`);
  } catch (_) {
    state.dailyCandles = [];
  }
  renderAllDailyMaLines();
}

// ---------------- bandas de bollinger (20, 2) ----------------

function bollinger(closes, period, mult) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function renderBollinger(pane) {
  pane.bbSeries.forEach((s) => pane.chart.removeSeries(s));
  pane.bbSeries = [];
  if (!pane.candles.length) return;

  const closes = pane.candles.map((c) => c.close);
  const times = pane.candles.map((c) => c.time);
  const { mid, upper, lower } = bollinger(closes, 20, 2);

  const specs = [
    { values: upper, color: "rgba(96,165,250,0.9)", width: 1, style: LC.LineStyle.Dashed },
    { values: mid, color: "rgba(148,163,184,0.8)", width: 1, style: LC.LineStyle.Solid },
    { values: lower, color: "rgba(96,165,250,0.9)", width: 1, style: LC.LineStyle.Dashed },
  ];
  specs.forEach((spec) => {
    const data = [];
    for (let i = 0; i < spec.values.length; i++) {
      if (spec.values[i] !== null) data.push({ time: times[i], value: spec.values[i] });
    }
    const series = pane.chart.addSeries(LC.LineSeries, {
      color: spec.color, lineWidth: spec.width, lineStyle: spec.style, visible: pane.bbVisible,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    series.setData(data);
    pane.bbSeries.push(series);
  });
}

// ---------------- líneas de tendencia — API de Primitives de lightweight-charts ----------------
// Mismo enfoque que usa TradingView internamente: se dibuja todo en canvas (línea + manejadores)
// vía un ISeriesPrimitive adjuntado a la serie de velas, en vez de divs superpuestos. Ventajas:
// el propio chart repinta los primitives automáticamente al hacer pan/zoom/resize (no hay que
// re-sincronizar posiciones a mano), y al dibujar con ctx.moveTo/lineTo no importa el orden
// cronológico de los puntos (a diferencia de una LineSeries.setData, que exige orden ascendente).

let activeDrag = null; // solo puede haber un arrastre a la vez en toda la página

function drawHandle(ctx, x, y, scope, square, color) {
  const r = 5 * scope.horizontalPixelRatio;
  ctx.beginPath();
  if (square) ctx.rect(x - r, y - r, r * 2, r * 2);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = square ? "#facc15" : (color || DRAW_COLORS[0]);
  ctx.fill();
  ctx.lineWidth = 2 * scope.horizontalPixelRatio;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}

class TrendLinePaneRenderer {
  constructor(p1, p2, options) { this._p1 = p1; this._p2 = p2; this._options = options; }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const p1 = this._p1, p2 = this._p2, o = this._options;
      if (p1.x == null || p1.y == null || p2.x == null || p2.y == null) return;
      const ctx = scope.context;
      const x1 = p1.x * scope.horizontalPixelRatio, y1 = p1.y * scope.verticalPixelRatio;
      const x2 = p2.x * scope.horizontalPixelRatio, y2 = p2.y * scope.verticalPixelRatio;
      ctx.save();
      ctx.lineWidth = (o.selected ? o.width + 1 : o.width) * scope.horizontalPixelRatio;
      ctx.strokeStyle = o.color;
      if (o.dashed) ctx.setLineDash([6 * scope.horizontalPixelRatio, 4 * scope.horizontalPixelRatio]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.restore();
      if (o.selected) {
        drawHandle(ctx, x1, y1, scope, false, o.color);
        drawHandle(ctx, x2, y2, scope, false, o.color);
        drawHandle(ctx, (x1 + x2) / 2, (y1 + y2) / 2, scope, true);
      }
    });
  }
}

class TrendLinePaneView {
  constructor(source) {
    this._source = source;
    this._p1px = { x: null, y: null };
    this._p2px = { x: null, y: null };
  }
  update(chart, series) {
    if (!chart || !series) return;
    const pane = this._source._pane;
    this._p1px = { x: timeToX(pane, this._source.p1.time), y: series.priceToCoordinate(this._source.p1.price) };
    this._p2px = { x: timeToX(pane, this._source.p2.time), y: series.priceToCoordinate(this._source.p2.price) };
  }
  renderer() { return new TrendLinePaneRenderer(this._p1px, this._p2px, this._source.options); }
}

class TrendLinePrimitive {
  constructor(pane, p1, p2, options) {
    this._pane = pane;
    this.p1 = p1;
    this.p2 = p2;
    this.options = { color: getDrawColor(), width: 2, selected: false, dashed: false, ...options };
    this._paneView = new TrendLinePaneView(this);
    this._chart = null;
    this._series = null;
    this._requestUpdateFn = null;
  }
  attached(param) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdateFn = param.requestUpdate;
    this.requestUpdate();
  }
  detached() { this._chart = null; this._series = null; this._requestUpdateFn = null; }
  updateAllViews() { this._paneView.update(this._chart, this._series); }
  paneViews() { return [this._paneView]; }
  requestUpdate() { if (this._requestUpdateFn) this._requestUpdateFn(); }
  setPoints(p1, p2) { this.p1 = p1; this.p2 = p2; this.requestUpdate(); }
  setSelected(sel) { this.options.selected = sel; this.requestUpdate(); }
}

// ---- rayo horizontal: desde un punto hacia la derecha, sin fin ----

class HRayPaneRenderer {
  constructor(p, options) { this._p = p; this._options = options; }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const p = this._p, o = this._options;
      if (p.x == null || p.y == null) return;
      const ctx = scope.context;
      const x = p.x * scope.horizontalPixelRatio, y = p.y * scope.verticalPixelRatio;
      if (x > scope.bitmapSize.width) return;
      ctx.save();
      ctx.lineWidth = (o.selected ? o.width + 1 : o.width) * scope.horizontalPixelRatio;
      ctx.strokeStyle = o.color;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(scope.bitmapSize.width, y); ctx.stroke();
      ctx.restore();
      if (o.selected) drawHandle(ctx, x, y, scope, false, o.color);
    });
  }
}

class HRayPaneView {
  constructor(source) { this._source = source; this._ppx = { x: null, y: null }; }
  update(chart, series) {
    if (!chart || !series) return;
    this._ppx = {
      x: timeToX(this._source._pane, this._source.p1.time),
      y: series.priceToCoordinate(this._source.p1.price),
    };
  }
  renderer() { return new HRayPaneRenderer(this._ppx, this._source.options); }
}

class HRayPrimitive {
  constructor(pane, p1, options) {
    this._pane = pane;
    this.p1 = p1;
    this.options = { color: getDrawColor(), width: 2, selected: false, ...options };
    this._paneView = new HRayPaneView(this);
    this._chart = null;
    this._series = null;
    this._requestUpdateFn = null;
  }
  attached(param) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdateFn = param.requestUpdate;
    this.requestUpdate();
  }
  detached() { this._chart = null; this._series = null; this._requestUpdateFn = null; }
  updateAllViews() { this._paneView.update(this._chart, this._series); }
  paneViews() { return [this._paneView]; }
  requestUpdate() { if (this._requestUpdateFn) this._requestUpdateFn(); }
  setPoints(p1) { this.p1 = p1; this.requestUpdate(); }
  setSelected(sel) { this.options.selected = sel; this.requestUpdate(); }
}

// Convierte un timestamp a coordenada X. Si el timestamp no coincide con ninguna
// vela de esta temporalidad (p. ej. una línea trazada en D1 vista en M15, o al
// revés), se interpola entre las velas vecinas o se extrapola en los extremos —
// así el mismo dibujo se ve en las dos pantallas aunque sus escalas difieran.
function timeToX(pane, time) {
  const ts = pane.chart.timeScale();
  const direct = ts.timeToCoordinate(time);
  if (direct != null) return direct;
  const c = pane.candles;
  if (c.length < 2) return null;
  const bs = ts.options().barSpacing || 6;
  const last = c[c.length - 1], first = c[0];
  if (time >= last.time) {
    const xl = ts.timeToCoordinate(last.time);
    if (xl == null) return null;
    const step = (last.time - c[c.length - 2].time) || 1;
    return xl + ((time - last.time) / step) * bs;
  }
  if (time <= first.time) {
    const xf = ts.timeToCoordinate(first.time);
    if (xf == null) return null;
    const step = (c[1].time - first.time) || 1;
    return xf - ((first.time - time) / step) * bs;
  }
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid].time <= time) lo = mid; else hi = mid;
  }
  const xa = ts.timeToCoordinate(c[lo].time), xb = ts.timeToCoordinate(c[hi].time);
  if (xa == null || xb == null) return null;
  const f = (time - c[lo].time) / (c[hi].time - c[lo].time);
  return xa + f * (xb - xa);
}

function pixelY(pane, price) { return pane.candleSeries.priceToCoordinate(price); }

function clampedTimeFromX(pane, x) {
  const w = pane.container.clientWidth;
  return pane.chart.timeScale().coordinateToTime(Math.max(0, Math.min(w, x)));
}
function clampedPriceFromY(pane, y) {
  const h = pane.container.clientHeight;
  return pane.candleSeries.coordinateToPrice(Math.max(0, Math.min(h, y)));
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTestDrawings(pane, x, y) {
  const TOL = 8;
  let best = null, bestDist = TOL;
  for (const p of pane.trendPrimitives) {
    const x1 = timeToX(pane, p.p1.time), y1 = pixelY(pane, p.p1.price);
    if (x1 == null || y1 == null) continue;
    let dist = null;
    if (p.__type === "hray") {
      if (x >= x1 - TOL) dist = Math.abs(y - y1);
    } else {
      const x2 = timeToX(pane, p.p2.time), y2 = pixelY(pane, p.p2.price);
      if (x2 == null || y2 == null) continue;
      dist = distToSegment(x, y, x1, y1, x2, y2);
    }
    if (dist != null && dist < bestDist) { bestDist = dist; best = p; }
  }
  return best;
}

function hitTestHandle(pane, id, x, y) {
  const p = pane.trendPrimitives.find((pp) => pp.__drawingId === id);
  if (!p) return null;
  const R = 10;
  const x1 = timeToX(pane, p.p1.time), y1 = pixelY(pane, p.p1.price);
  if (x1 == null || y1 == null) return null;
  if (p.__type === "hray") {
    if (Math.hypot(x - x1, y - y1) < R) return "p1";
    if (x >= x1 && Math.abs(y - y1) < R - 2) return "move";
    return null;
  }
  const x2 = timeToX(pane, p.p2.time), y2 = pixelY(pane, p.p2.price);
  if (x2 == null || y2 == null) return null;
  if (Math.hypot(x - x1, y - y1) < R) return "p1";
  if (Math.hypot(x - x2, y - y2) < R) return "p2";
  if (Math.hypot(x - (x1 + x2) / 2, y - (y1 + y2) / 2) < R) return "move";
  return null;
}

function restyleDrawing(pane, id, selected) {
  const p = pane.trendPrimitives.find((pp) => pp.__drawingId === id);
  if (p) p.setSelected(selected);
}

function deselectDrawing(pane) {
  if (pane.selectedDrawingId != null) restyleDrawing(pane, pane.selectedDrawingId, false);
  pane.selectedDrawingId = null;
}

function selectDrawing(pane, id) {
  if (pane.selectedDrawingId === id) return;
  deselectDrawing(pane);
  pane.selectedDrawingId = id;
  restyleDrawing(pane, id, true);
}

async function deleteDrawing(pane, id) {
  const arr = getSymbolDrawings(state.symbol).filter((d) => d.id !== id);
  setSymbolDrawings(state.symbol, arr);
  if (pane.selectedDrawingId === id) pane.selectedDrawingId = null;
  loadAllDrawings();
}

function startDrag(pane, e, id, mode) {
  const rect = pane.container.getBoundingClientRect();
  const p = pane.trendPrimitives.find((pp) => pp.__drawingId === id);
  const drag = { pane, id, mode, rect, p };
  if (mode === "move") {
    drag.origPix1 = { x: timeToX(pane, p.p1.time), y: pixelY(pane, p.p1.price) };
    if (p.__type !== "hray") drag.origPix2 = { x: timeToX(pane, p.p2.time), y: pixelY(pane, p.p2.price) };
    drag.startX = e.clientX;
    drag.startY = e.clientY;
  }
  activeDrag = drag;
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
}

function onDragMove(e) {
  const drag = activeDrag;
  if (!drag) return;
  const { pane, p } = drag;
  const x = e.clientX - drag.rect.left;
  const y = e.clientY - drag.rect.top;
  const isRay = p.__type === "hray";

  if (drag.mode === "p1" || drag.mode === "p2") {
    const time = clampedTimeFromX(pane, x);
    const price = clampedPriceFromY(pane, y);
    if (time == null || price == null) return;
    if (isRay) p.setPoints({ time, price });
    else if (drag.mode === "p1") p.setPoints({ time, price }, p.p2);
    else p.setPoints(p.p1, { time, price });
  } else if (drag.mode === "move") {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const t1 = clampedTimeFromX(pane, drag.origPix1.x + dx);
    const pr1 = clampedPriceFromY(pane, drag.origPix1.y + dy);
    if (t1 == null || pr1 == null) return;
    if (isRay) { p.setPoints({ time: t1, price: pr1 }); return; }
    const t2 = clampedTimeFromX(pane, drag.origPix2.x + dx);
    const pr2 = clampedPriceFromY(pane, drag.origPix2.y + dy);
    if (t2 == null || pr2 == null) return;
    p.setPoints({ time: t1, price: pr1 }, { time: t2, price: pr2 });
  }
}

async function onDragEnd() {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  const drag = activeDrag;
  activeDrag = null;
  if (!drag) return;
  const arr = getSymbolDrawings(state.symbol);
  const rec = arr.find((d) => d.id === drag.id);
  if (rec) {
    rec.data = drag.p.__type === "hray"
      ? { p1: drag.p.p1, color: drag.p.options.color }
      : { p1: drag.p.p1, p2: drag.p.p2, color: drag.p.options.color };
    setSymbolDrawings(state.symbol, arr);
  }
  // Sincroniza el mismo dibujo en la otra pantalla.
  Object.values(panes).forEach((p) => { if (p !== drag.pane) loadDrawings(p); });
}

function clearPreview(pane) {
  if (pane.previewPrimitive) { pane.candleSeries.detachPrimitive(pane.previewPrimitive); pane.previewPrimitive = null; }
}

// mode: null (desarmado) | "trend" (línea de tendencia, 2 clics) | "hray" (rayo horizontal, 1 clic)
function setDrawMode(pane, mode) {
  pane.drawMode = mode || null;
  pane.pendingPoint = null;
  clearPreview(pane);
  deselectDrawing(pane);
  pane.container.classList.toggle("drawing-armed", !!mode);
  const tbtn = document.querySelector(`.btn-toggle-trend[data-pane="${pane.letter}"]`);
  const hbtn = document.querySelector(`.btn-toggle-hray[data-pane="${pane.letter}"]`);
  if (tbtn) tbtn.classList.toggle("active", mode === "trend");
  if (hbtn) hbtn.classList.toggle("active", mode === "hray");
  // Mientras se traza, se desactiva el paneo/zoom: si no, un clic con el más mínimo
  // movimiento del mouse se interpreta como arrastre de la vista en vez de un clic.
  pane.chart.applyOptions({ handleScroll: !mode, handleScale: !mode });
}

function clearDrawingSeries(pane) {
  pane.trendPrimitives.forEach((p) => pane.candleSeries.detachPrimitive(p));
  pane.trendPrimitives = [];
  deselectDrawing(pane);
}

function renderDrawing(pane, d) {
  const type = d.type || "trend";
  const primitive = type === "hray"
    ? new HRayPrimitive(pane, d.data.p1, { color: d.data.color || getDrawColor() })
    : new TrendLinePrimitive(pane, d.data.p1, d.data.p2, { color: d.data.color || getDrawColor() });
  primitive.__drawingId = d.id;
  primitive.__type = type;
  pane.candleSeries.attachPrimitive(primitive);
  pane.trendPrimitives.push(primitive);
}

async function loadDrawings(pane) {
  clearDrawingSeries(pane);
  pane.drawings = getSymbolDrawings(state.symbol);
  pane.drawings.forEach((d) => renderDrawing(pane, d));
}

// El mismo dibujo se ve en ambas pantallas: tras crear/borrar/recolorear se recargan las dos.
function loadAllDrawings() {
  Object.values(panes).forEach((p) => loadDrawings(p));
}

function recolorDrawing(pane, id, color) {
  const arr = getSymbolDrawings(state.symbol);
  const rec = arr.find((d) => d.id === id);
  if (!rec) return;
  rec.data.color = color;
  setSymbolDrawings(state.symbol, arr);
  loadAllDrawings();
  selectDrawing(pane, id);
}

function setupDrawingTool(pane) {
  const btn = document.querySelector(`.btn-toggle-trend[data-pane="${pane.letter}"]`);
  btn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "trend" ? null : "trend"));
  const hrayBtn = document.querySelector(`.btn-toggle-hray[data-pane="${pane.letter}"]`);
  hrayBtn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "hray" ? null : "hray"));

  // Paleta de color: cambia el color para los próximos dibujos y, si hay un
  // dibujo seleccionado en este panel, lo recolorea al instante.
  const colorWrap = document.querySelector(`.color-picker-wrap[data-pane="${pane.letter}"]`);
  const colorBtn = colorWrap.querySelector(".btn-draw-color");
  const colorMenu = colorWrap.querySelector(".color-menu");
  colorMenu.innerHTML = DRAW_COLORS.map((c) => `<button class="color-opt" data-color="${c}" style="background:${c}"></button>`).join("");
  colorBtn.querySelector(".color-dot").style.background = getDrawColor();
  colorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".color-menu").forEach((m) => { if (m !== colorMenu) m.classList.add("hidden"); });
    colorMenu.classList.toggle("hidden");
  });
  colorMenu.querySelectorAll(".color-opt").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const c = b.dataset.color;
    setDrawColorPref(c);
    document.querySelectorAll(".btn-draw-color .color-dot").forEach((d) => { d.style.background = c; });
    colorMenu.classList.add("hidden");
    if (pane.selectedDrawingId != null) recolorDrawing(pane, pane.selectedDrawingId, c);
  }));

  // Fase de captura: se intercepta el mousedown ANTES de que llegue al canvas interno de la
  // librería, para que si cae sobre un manejador de la línea seleccionada, el propio chart
  // nunca lo interprete como inicio de un paneo.
  pane.container.addEventListener("mousedown", (e) => {
    if (pane.selectedDrawingId == null) return;
    const rect = pane.container.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const mode = hitTestHandle(pane, pane.selectedDrawingId, x, y);
    if (!mode) return;
    e.preventDefault();
    e.stopPropagation();
    startDrag(pane, e, pane.selectedDrawingId, mode);
  }, true);

  pane.chart.subscribeClick((param) => {
    if (!param.point) return;

    if (!pane.drawMode) {
      const hit = hitTestDrawings(pane, param.point.x, param.point.y);
      if (hit) selectDrawing(pane, hit.__drawingId); else deselectDrawing(pane);
      return;
    }
    if (!param.time) return;
    const price = pane.candleSeries.coordinateToPrice(param.point.y);
    if (price === null) return;

    if (pane.drawMode === "hray") {
      const arr = getSymbolDrawings(state.symbol);
      arr.push({ id: nextDrawingId(), type: "hray", data: { p1: { time: param.time, price }, color: getDrawColor() } });
      setSymbolDrawings(state.symbol, arr);
      loadAllDrawings();
      setDrawMode(pane, null);
      return;
    }

    if (!pane.pendingPoint) {
      pane.pendingPoint = { time: param.time, price };
    } else {
      const p1 = pane.pendingPoint;
      const p2 = { time: param.time, price };
      pane.pendingPoint = null;
      clearPreview(pane);
      const arr = getSymbolDrawings(state.symbol);
      arr.push({ id: nextDrawingId(), type: "trend", data: { p1, p2, color: getDrawColor() } });
      setSymbolDrawings(state.symbol, arr);
      loadAllDrawings();
      setDrawMode(pane, null);
    }
  });

  pane.chart.subscribeCrosshairMove((param) => {
    if (pane.drawMode !== "trend" || !pane.pendingPoint || !param.point || !param.time) return;
    const price = pane.candleSeries.coordinateToPrice(param.point.y);
    if (price == null) return;
    if (!pane.previewPrimitive) {
      pane.previewPrimitive = new TrendLinePrimitive(pane, pane.pendingPoint, { time: param.time, price }, { dashed: true });
      pane.candleSeries.attachPrimitive(pane.previewPrimitive);
    } else {
      pane.previewPrimitive.setPoints(pane.pendingPoint, { time: param.time, price });
    }
  });
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".color-picker-wrap")) {
    document.querySelectorAll(".color-menu").forEach((m) => m.classList.add("hidden"));
  }
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "Escape") {
    Object.values(panes).forEach((p) => { if (p.drawMode) setDrawMode(p, null); });
  } else if (e.key === "Delete") {
    Object.values(panes).forEach((p) => {
      if (p.selectedDrawingId != null) deleteDrawing(p, p.selectedDrawingId);
    });
  }
});

// ---------------- symbol / interval loading ----------------

// Enfoca las últimas ~150 velas con un pequeño margen a la derecha: en cualquier
// temporalidad se ve lo último que hace el precio con velas legibles, en vez de
// todo el histórico amontonado (que era lo que hacía fitContent).
function focusLatest(pane) {
  const n = pane.candles.length;
  if (!n) return;
  pane.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 6 });
}

async function loadCandles(pane, forceRefresh) {
  const qs = forceRefresh ? "?refresh=true" : "";
  pane.candles = await api(`/api/candles/${state.symbol}/${pane.interval}${qs}`);
  pane.candleSeries.setData(pane.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  focusLatest(pane);
  // Reactiva el auto-escalado del eje de precios: al cambiar de activo (o temporalidad)
  // el gráfico vuelve a centrarse en el nuevo rango de precios, aunque el usuario haya
  // arrastrado el eje antes (eso apaga el auto-escalado hasta que se reactiva).
  pane.candleSeries.priceScale().applyOptions({ autoScale: true });
  renderMAs(pane);
  renderBollinger(pane);
  updateEarningsMarkers(pane);
  await loadDrawings(pane);
  if (pane.letter === "A") updateCurrentPrice();
}

async function updateCurrentPrice() {
  document.getElementById("curSymbol").textContent = state.symbol;
  const candles = panes.A.candles;
  if (!candles.length) return;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2].close : last.open;
  renderPrice(last.close, prev);
  try {
    const r = await api(`/api/price/${state.symbol}`);
    renderPrice(r.price, prev);
  } catch (_) {}
}

function renderPrice(price, prev) {
  const priceEl = document.getElementById("curPrice");
  const changeEl = document.getElementById("curChange");
  priceEl.textContent = price.toFixed(2);
  const diff = price - prev;
  const pct = prev ? (diff / prev) * 100 : 0;
  changeEl.textContent = `${diff >= 0 ? "+" : ""}${diff.toFixed(2)} (${pct.toFixed(2)}%)`;
  changeEl.className = "change " + (diff >= 0 ? "up" : "down");
}

async function selectSymbol(ticker) {
  state.symbol = ticker.toUpperCase();
  document.querySelectorAll(".wl-symbol").forEach((el) => el.classList.toggle("active", el.dataset.ticker === state.symbol));
  await Promise.all([
    loadCandles(panes.A), loadCandles(panes.B),
    loadMAConfig(), loadAlarms(), loadEarnings(), loadTargetPrice(), loadDailyReference(),
  ]);
}

document.querySelectorAll(".btn-refresh-pane").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pane = panes[btn.dataset.pane];
    btn.disabled = true;
    try {
      await loadCandles(pane, true);
      applyDailyMaLines(pane); // mismo símbolo: state.dailyCandles ya es válido, sin condición de carrera
      toast(`${state.symbol} (${pane.interval}) actualizado con los últimos datos.`);
    } catch (e) {
      toast("Error al actualizar: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });
});

document.querySelectorAll(".btn-toggle-ma").forEach((btn) => {
  btn.addEventListener("click", () => {
    const pane = panes[btn.dataset.pane];
    pane.maVisible = !pane.maVisible;
    btn.classList.toggle("active", pane.maVisible);
    pane.maSeries.forEach((s) => s.applyOptions({ visible: pane.maVisible }));
    pane.dailyMaLines.forEach((pl) => pl.applyOptions({ lineVisible: pane.maVisible, axisLabelVisible: pane.maVisible }));
  });
});

document.querySelectorAll(".btn-toggle-bb").forEach((btn) => {
  btn.addEventListener("click", () => {
    const pane = panes[btn.dataset.pane];
    pane.bbVisible = !pane.bbVisible;
    btn.classList.toggle("active", pane.bbVisible);
    pane.bbSeries.forEach((s) => s.applyOptions({ visible: pane.bbVisible }));
  });
});

document.querySelectorAll(".intervals").forEach((group) => {
  const pane = panes[group.dataset.pane];
  group.querySelectorAll(".ivl-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      group.querySelectorAll(".ivl-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      pane.interval = btn.dataset.interval;
      pane.chart.applyOptions({ timeScale: { timeVisible: pane.interval !== "1d" } });
      await loadCandles(pane);
      applyDailyMaLines(pane); // mismo símbolo: state.dailyCandles ya es válido, sin condición de carrera
    });
  });
});

// ---------------- vista dividida (dos temporalidades) ----------------

const chartPanesEl = document.getElementById("chartPanes");
const btnSplitView = document.getElementById("btnSplitView");
let splitViewEnabled = localStorage.getItem("splitView") === "1";

function applySplitView() {
  chartPanesEl.classList.toggle("split", splitViewEnabled);
  btnSplitView.classList.toggle("active", splitViewEnabled);
  requestAnimationFrame(() => Object.values(panes).forEach((p) => focusLatest(p)));
}

btnSplitView.addEventListener("click", () => {
  splitViewEnabled = !splitViewEnabled;
  localStorage.setItem("splitView", splitViewEnabled ? "1" : "0");
  applySplitView();
});

applySplitView();

// ---------------- target price (línea horizontal automática) ----------------

async function loadTargetPrice() {
  try {
    state.targetPrice = await api(`/api/target-price/${state.symbol}`);
  } catch (_) {
    state.targetPrice = null;
  }
  Object.values(panes).forEach((p) => applyTargetPriceLine(p));
}

function applyTargetPriceLine(pane) {
  if (pane.targetPriceLine) {
    try { pane.candleSeries.removePriceLine(pane.targetPriceLine); } catch (_) {}
    pane.targetPriceLine = null;
  }
  if (state.targetPrice && state.targetPrice.average) {
    pane.targetPriceLine = pane.candleSeries.createPriceLine({
      price: state.targetPrice.average, color: "#facc15", lineWidth: 2,
      lineStyle: LC.LineStyle.Solid, axisLabelVisible: true,
      title: `Target $${state.targetPrice.average.toFixed(2)}`,
    });
  }
}

// ---------------- escáner de tendencia (SMA en D1 y H1) ----------------

const TREND_TF_ORDER = ["1d", "1h"];
const TREND_TF_LABEL = { "1d": "D1", "1h": "H1" };
let trendScanPollTimer = null;

async function loadTrendScan() {
  try {
    const r = await api("/api/trend-scan");
    state.trendScan = r.trends || {};
    updateAllTrendCircles();
    return r.status;
  } catch (e) {
    return null;
  }
}

// Genera los 8 círculos (D1 primero, luego H1) para un ticker.
function trendCirclesHtml(ticker) {
  const data = state.trendScan[ticker];
  let html = "";
  TREND_TF_ORDER.forEach((tf, gi) => {
    const circles = (data && data[tf]) || ["neutral", "neutral", "neutral", "neutral"];
    html += `<span class="tf-group" title="${TREND_TF_LABEL[tf]}: 20/40, 40/100, 100/200, total">`;
    circles.forEach((st, i) => {
      const summary = i === 3 ? " summary" : "";
      html += `<span class="tdot ${st}${summary}"></span>`;
    });
    html += `</span>`;
    if (gi === 0) html += `<span class="tf-sep"></span>`;
  });
  return html;
}

// Actualiza los círculos ya renderizados sin recrear toda la lista.
function updateAllTrendCircles() {
  document.querySelectorAll(".wls-trend[data-ticker]").forEach((el) => {
    el.innerHTML = trendCirclesHtml(el.dataset.ticker);
  });
}

async function refreshTrendScan() {
  const btn = document.getElementById("btnRefreshTrend");
  if (btn) btn.classList.add("scanning");
  try {
    await api("/api/trend-scan/refresh", { method: "POST" });
    if (trendScanPollTimer) clearInterval(trendScanPollTimer);
    trendScanPollTimer = setInterval(async () => {
      const status = await loadTrendScan();
      if (!status || !status.running) {
        clearInterval(trendScanPollTimer);
        trendScanPollTimer = null;
        if (btn) btn.classList.remove("scanning");
        toast("Escáner de tendencia actualizado.");
      }
    }, 4000);
  } catch (e) {
    if (btn) btn.classList.remove("scanning");
    toast("Error al actualizar el escáner: " + e.message);
  }
}

// ---------------- escáner de saltos (consolidación premarket + gap de apertura) ----------------

let saltosNotified = new Set();
let saltosDate = null;
let saltosHearts = [];       // tickers con corazón, el más reciente primero
let lastSaltosState = null;  // para re-renderizar al marcar/desmarcar sin esperar el poll

const SALTO_BADGES = {
  consolidado: { cls: "consolidado", text: "consolidado" },
  sin_salto: { cls: "sin-salto", text: "sin salto" },
  salto_alza: { cls: "alza", text: "SALTO ↑ → PUT" },
  salto_baja: { cls: "baja", text: "SALTO ↓ → CALL" },
};

// Orden: primero los que dieron salto (mayor salto arriba), luego los marcados
// con corazón (en su orden de marcado), y el resto conserva su orden.
function sortSaltosTickers(tickers, candidates) {
  const jumped = (t) => {
    const s = candidates[t]?.status;
    return s === "salto_alza" || s === "salto_baja";
  };
  return [...tickers].sort((a, b) => {
    const ja = jumped(a), jb = jumped(b);
    if (ja && jb) return (candidates[b].jump || 0) - (candidates[a].jump || 0);
    if (ja) return -1;
    if (jb) return 1;
    const ia = saltosHearts.indexOf(a), ib = saltosHearts.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return 0;
  });
}

function renderSaltos(st) {
  lastSaltosState = st;
  saltosHearts = getLocalHearts();
  const pctInput = document.getElementById("saltoJumpPct");
  if (st.jump_pct != null && document.activeElement !== pctInput) pctInput.value = st.jump_pct;
  const list = document.getElementById("saltosList");
  const hint = document.getElementById("saltosEmptyHint");
  const statusEl = document.getElementById("saltosStatus");
  const tickers = sortSaltosTickers(Object.keys(st.candidates || {}), st.candidates || {});
  const phaseText = { esperando: "esperando premarket", consolidado: "consolidación detectada", evaluado: "salto evaluado" };
  statusEl.textContent = st.updated_at ? `${phaseText[st.phase] || st.phase} · ${st.updated_at}` : "sin escaneo aún";
  list.innerHTML = "";
  tickers.forEach((t) => {
    const c = st.candidates[t];
    const b = SALTO_BADGES[c.status] || SALTO_BADGES.consolidado;
    const hearted = saltosHearts.includes(t);
    const row = document.createElement("div");
    row.className = "salto-row" + (t === state.symbol ? " active" : "");
    row.innerHTML = `
      <div class="salto-top">
        <span class="wls-ticker">${t}</span>
        <span class="salto-badge ${b.cls}">${b.text}</span>
        <button class="salto-heart${hearted ? " active" : ""}" title="${hearted ? "Quitar de arriba" : "Fijar arriba"}"><i class="fa-solid fa-heart"></i></button>
      </div>
      <div class="salto-sub">Rango ${c.range_low.toFixed(2)}–${c.range_high.toFixed(2)} ($${c.range_size.toFixed(2)})${c.open_price != null ? ` · apertura $${c.open_price.toFixed(2)}` : ""}${c.eval_price != null && c.eval_price !== c.open_price ? ` · pico $${c.eval_price.toFixed(2)}` : ""}</div>`;
    row.addEventListener("click", (e) => { if (!e.target.closest(".salto-heart")) selectSymbol(t); });
    row.querySelector(".salto-heart").addEventListener("click", (e) => {
      e.stopPropagation();
      const hearts = getLocalHearts();
      const i = hearts.indexOf(t);
      if (i !== -1) hearts.splice(i, 1); else hearts.unshift(t); // el recién marcado va de primero
      setLocalHearts(hearts);
      if (lastSaltosState) renderSaltos(lastSaltosState);
    });
    list.appendChild(row);
  });
  hint.style.display = tickers.length ? "none" : "block";
}

async function pollSaltos() {
  try {
    const st = await api("/api/saltos");
    if (st.date !== saltosDate) { saltosDate = st.date; saltosNotified = new Set(); }
    renderSaltos(st);
    Object.entries(st.candidates || {}).forEach(([t, c]) => {
      if ((c.status === "salto_alza" || c.status === "salto_baja") && !saltosNotified.has(t)) {
        saltosNotified.add(t);
        const dir = c.status === "salto_alza" ? "al ALZA" : "a la BAJA";
        const msg = `${t}: salto ${dir} de $${c.jump.toFixed(2)} (apertura $${c.open_price.toFixed(2)}) → ${c.operation}`;
        toast(msg, true, "fa-bolt");
        beep();
      }
    });
  } catch (_) {}
  setTimeout(pollSaltos, 10000);
}

document.getElementById("btnScanSaltos").addEventListener("click", async () => {
  const btn = document.getElementById("btnScanSaltos");
  btn.disabled = true;
  try {
    const st = await api("/api/saltos/scan", { method: "POST" });
    renderSaltos(st);
    toast(`Escaneo de consolidación: ${Object.keys(st.candidates || {}).length} candidato(s).`);
  } catch (e) {
    toast("Error del escáner de saltos: " + e.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnSaveSaltoPct").addEventListener("click", async () => {
  const btn = document.getElementById("btnSaveSaltoPct");
  const pct = parseFloat(document.getElementById("saltoJumpPct").value);
  if (!(pct > 0)) { toast("Porcentaje inválido."); return; }
  btn.disabled = true;
  try {
    await api("/api/saltos/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jump_pct: pct }),
    });
    // Reevalúa de inmediato con el nuevo umbral (escanea antes si no hay candidatos).
    let st = await api("/api/saltos");
    if (!Object.keys(st.candidates || {}).length) st = await api("/api/saltos/scan", { method: "POST" });
    st = await api("/api/saltos/evaluate", { method: "POST" });
    renderSaltos(st);
    const n = Object.values(st.candidates || {}).filter((c) => c.status === "salto_alza" || c.status === "salto_baja").length;
    toast(`Salto mínimo: ${pct}% del rango. Reevaluado: ${n} salto(s) detectado(s).`);
  } catch (e) {
    toast("Error al guardar: " + e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- watchlist ----------------

async function loadWatchlist() {
  const [groups, nextMap] = await Promise.all([
    api("/api/watchlist"),
    api("/api/earnings/next-all"),
  ]);
  state.nextEarningsMap = nextMap;
  state.watchlistGroups = groups;
  await migrateLocalPersonalization(groups);
  rerenderWatchlist();
}

// Re-render sin volver a consultar al servidor (p. ej. al marcar un favorito local).
function rerenderWatchlist() {
  const groups = state.watchlistGroups || [];
  const tree = document.getElementById("watchlistTree");
  tree.innerHTML = "";
  groups.forEach((g) => tree.appendChild(renderGroup(g)));
  renderFavoritesTab(groups);
}

function renderFavoritesTab(groups) {
  const favTree = document.getElementById("favoritesTree");
  const hint = document.getElementById("favoritesEmptyHint");
  favTree.innerHTML = "";
  const favs = getLocalFavs();
  const favorites = [];
  groups.forEach((g) => {
    const showPremarket = /etf|materia/i.test(g.name);
    g.symbols.forEach((s) => { if (favs.includes(s.ticker)) favorites.push({ s, showPremarket }); });
  });
  const sorted = sortByEarnings(favorites.map((f) => f.s));
  const showMap = new Map(favorites.map((f) => [f.s.id, f.showPremarket]));
  sorted.forEach((s) => favTree.appendChild(renderSymbol(s, showMap.get(s.id))));
  hint.style.display = sorted.length ? "none" : "block";
}

// Ordena por fecha del próximo reporte de ganancias (más próximo primero); los
// símbolos sin fecha (ETFs, materias primas) quedan al final, en su orden original.
function sortByEarnings(symbols) {
  return [...symbols].sort((a, b) => {
    const da = state.nextEarningsMap[a.ticker]?.date;
    const db = state.nextEarningsMap[b.ticker]?.date;
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    if (da) return -1;
    if (db) return 1;
    return 0;
  });
}

function renderGroup(g) {
  const div = document.createElement("div");
  div.className = "wl-group";
  div.innerHTML = `
    <div class="wl-group-header">
      <span class="caret"><i class="fa-solid fa-chevron-down"></i></span>
      <span class="wl-group-name">${escapeHtml(g.name)}</span>
      <button class="wl-group-del" title="Eliminar grupo"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wl-symbols" data-group-id="${g.id}"></div>`;

  div.querySelector(".wl-group-header").addEventListener("click", (e) => {
    if (e.target.closest(".wl-group-del")) return;
    div.classList.toggle("collapsed");
  });
  div.querySelector(".wl-group-del").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`¿Eliminar el grupo "${g.name}" y sus símbolos?`)) return;
    await api(`/api/watchlist/groups/${g.id}`, { method: "DELETE" });
    loadWatchlist();
  });

  const symsEl = div.querySelector(".wl-symbols");
  symsEl.addEventListener("dragover", (e) => { e.preventDefault(); symsEl.classList.add("drag-over"); });
  symsEl.addEventListener("dragleave", () => symsEl.classList.remove("drag-over"));
  symsEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    symsEl.classList.remove("drag-over");
    const sid = e.dataTransfer.getData("text/symbol-id");
    if (sid) {
      await api(`/api/watchlist/symbols/${sid}/move`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: g.id }),
      });
      loadWatchlist();
    }
  });

  const showPremarket = /etf|materia/i.test(g.name);
  sortByEarnings(g.symbols).forEach((s) => symsEl.appendChild(renderSymbol(s, showPremarket)));
  return div;
}

function renderSymbol(s, showPremarket) {
  const el = document.createElement("div");
  el.className = "wl-symbol" + (s.ticker === state.symbol ? " active" : "");
  el.dataset.ticker = s.ticker;
  el.draggable = true;
  const next = state.nextEarningsMap[s.ticker];
  const statusLabel = next ? (STATUS_LABELS[next.status] || next.status) : "";
  const timeLabel = next && next.time_of_day ? TIME_LABELS[next.time_of_day] : "";
  const timeShort = next && next.time_of_day ? ` ${TIME_SHORT[next.time_of_day]}` : "";
  const badge = next
    ? `<span class="wls-earnings ${next.status}" title="Próximo reporte: ${next.date}${timeLabel ? " — " + timeLabel : ""} (${statusLabel})"><i class="fa-solid fa-calendar-days"></i> ${formatShortDate(next.date)}${timeShort}</span>`
    : "";
  const isFav = getLocalFavs().includes(s.ticker);
  el.innerHTML = `
    <div class="wl-symbol-top">
      <button class="wls-fav${isFav ? " active" : ""}" title="${isFav ? "Quitar de favoritos" : "Agregar a favoritos"}"><i class="fa-solid fa-star"></i></button>
      <span class="wls-ticker">${s.ticker}</span><span class="wls-name">${escapeHtml(s.name || "")}</span>${badge}<button class="wls-del"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wls-trend" data-ticker="${s.ticker}">${trendCirclesHtml(s.ticker)}</div>
    ${showPremarket ? `<div class="wls-premarket"></div>` : ""}`;
  el.addEventListener("click", (e) => { if (!e.target.closest(".wls-del") && !e.target.closest(".wls-fav")) selectSymbol(s.ticker); });
  el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/symbol-id", s.id));
  el.querySelector(".wls-del").addEventListener("click", async (e) => {
    e.stopPropagation();
    await api(`/api/watchlist/symbols/${s.id}`, { method: "DELETE" });
    loadWatchlist();
  });
  el.querySelector(".wls-fav").addEventListener("click", (e) => {
    e.stopPropagation();
    const favs = getLocalFavs();
    const i = favs.indexOf(s.ticker);
    if (i !== -1) favs.splice(i, 1); else favs.push(s.ticker);
    setLocalFavs(favs);
    rerenderWatchlist();
  });
  if (showPremarket) loadPremarketBadge(s.ticker, el.querySelector(".wls-premarket"));
  return el;
}

async function loadPremarketBadge(ticker, el) {
  if (!el) return;
  try {
    const q = await api(`/api/premarket/${ticker}`);
    if (q.session !== "premarket") { el.remove(); return; }
    const up = q.change >= 0;
    el.innerHTML = `<span class="pm-tag">PREMARKET</span> $${q.price.toFixed(2)} ` +
      `<span class="pm-change ${up ? "up" : "down"}"><i class="fa-solid fa-caret-${up ? "up" : "down"}"></i> ` +
      `${Math.abs(q.change).toFixed(2)} (${Math.abs(q.change_pct).toFixed(2)}%)</span>`;
  } catch (_) {
    el.remove();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("btnAddGroup").addEventListener("click", async () => {
  const name = prompt("Nombre del nuevo grupo:");
  if (!name) return;
  await api("/api/watchlist/groups", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
  loadWatchlist();
});

document.getElementById("btnRefreshTrend").addEventListener("click", refreshTrendScan);

// ---------------- search ----------------

let searchTimer = null;
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { searchResults.classList.add("hidden"); return; }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
      renderSearchResults(results);
    } catch (e) { toast("Error de búsqueda: " + e.message); }
  }, 400);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) searchResults.classList.add("hidden");
});

function renderSearchResults(results) {
  if (!results.length) { searchResults.classList.add("hidden"); return; }
  searchResults.innerHTML = results.map((r) =>
    `<div class="sr-item" data-ticker="${r.ticker}" data-name="${escapeHtml(r.name)}">
      <div class="sr-ticker">${r.ticker} <small>${r.exchange || ""}</small></div>
      <div class="sr-name">${escapeHtml(r.name)}</div>
    </div>`).join("");
  searchResults.classList.remove("hidden");
  searchResults.querySelectorAll(".sr-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const ticker = item.dataset.ticker;
      const name = item.dataset.name;
      let groups = await api("/api/watchlist");
      let groupId;
      if (!groups.length) {
        const r = await api("/api/watchlist/groups", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Mi lista" }),
        });
        groupId = r.id;
      } else {
        groupId = groups[0].id;
      }
      await api("/api/watchlist/symbols", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, name, group_id: groupId }),
      });
      await loadWatchlist();
      searchResults.classList.add("hidden");
      searchInput.value = "";
      selectSymbol(ticker);
    });
  });
}

// ---------------- MA config ----------------

async function loadMAConfig() {
  const r = await api(`/api/ma-config?symbol=${state.symbol}`);
  state.maConfig = r.config;
  state.maScope = r.scope;
  renderAllMAs();
  renderAllDailyMaLines();
}

// ---------------- alarms (solo líneas en el gráfico; el panel de gestión se quitó) ----------------

async function loadAlarms() {
  try {
    state.alarms = await api(`/api/alarms?symbol=${state.symbol}`);
  } catch (_) {
    state.alarms = [];
  }
  Object.values(panes).forEach((p) => applyAlarmPriceLines(p));
}

function applyAlarmPriceLines(pane) {
  pane.alarmPriceLines.forEach((pl) => { try { pane.candleSeries.removePriceLine(pl); } catch (_) {} });
  pane.alarmPriceLines = [];
  state.alarms.filter((a) => a.active).forEach((a) => {
    const pl = pane.candleSeries.createPriceLine({
      price: a.price, color: "#ef4444", lineWidth: 1, lineStyle: LC.LineStyle.Dotted,
      axisLabelVisible: true, title: "alarma",
    });
    pane.alarmPriceLines.push(pl);
  });
}

async function pollAlarmEvents() {
  try {
    const events = await api("/api/alarms/events");
    events.forEach((ev) => {
      const dirText = ev.direction === "above" ? "cruzó arriba de" : "cruzó abajo de";
      const msg = `${ev.symbol} ${dirText} $${ev.target} (precio actual: $${ev.price.toFixed(2)})`;
      toast(msg, true, "fa-bell");
      notifyBrowser("Alarma: " + ev.symbol, msg);
      beep();
      if (ev.symbol === state.symbol) loadAlarms();
    });
  } catch (_) {}
  setTimeout(pollAlarmEvents, 20000);
}

// ---------------- earnings (registro manual) ----------------

const STATUS_LABELS = { reportado: "Reportado", confirmado: "Confirmado", estimado: "Estimado" };
const TIME_LABELS = {
  AMC: "Después del cierre (AMC, hora NY)",
  BMO: "Antes de la apertura (BMO, hora NY)",
  "": "",
};
const TIME_SHORT = { AMC: "AMC", BMO: "BMO", "": "" };

// Solo se usa para alimentar los marcadores "E" en el gráfico diario y el badge
// de próximo reporte en la watchlist (vía /api/earnings/next-all en loadWatchlist).
async function loadEarnings() {
  try {
    const result = await api(`/api/earnings/${state.symbol}`);
    state.earnings = result.earnings;
  } catch (_) {
    state.earnings = [];
  }
  Object.values(panes).forEach((p) => updateEarningsMarkers(p));
}

function updateEarningsMarkers(pane) {
  if (pane.interval !== "1d" || !state.earnings.length) {
    pane.earningsMarkersPrimitive.setMarkers([]);
    return;
  }
  const candleTimes = new Set(pane.candles.map((c) => c.time));
  const markers = state.earnings
    .filter((e) => candleTimes.has(e.ts))
    .map((e) => ({ time: e.ts, position: "belowBar", color: "#a855f7", shape: "circle", text: "E" }));
  pane.earningsMarkersPrimitive.setMarkers(markers);
}

// ---------------- tabs ----------------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const scope = btn.closest(".tab-group") || document;
    scope.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    scope.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---------------- snapshot ----------------

document.getElementById("btnSnapshot").addEventListener("click", async () => {
  const canvas = panes.A.chart.takeScreenshot();
  const dataUrl = canvas.toDataURL("image/png");
  try {
    await api("/api/snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: state.symbol, interval: panes.A.interval, image: dataUrl }),
    });
    toast("Captura guardada en la carpeta capturas/.");
  } catch (e) { toast("Error al guardar captura: " + e.message); }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `${state.symbol}_${panes.A.interval}.png`;
  a.click();
});

// ---------------- settings ----------------

const settingsModal = document.getElementById("settingsModal");
document.getElementById("btnSettings").addEventListener("click", async () => {
  const s = await api("/api/settings");
  document.getElementById("apiKeyInput").value = s.api_key || "";
  settingsModal.classList.remove("hidden");
});
document.getElementById("btnCloseSettings").addEventListener("click", () => settingsModal.classList.add("hidden"));
document.getElementById("btnSaveApiKey").addEventListener("click", async () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  await api("/api/settings/api-key", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key }),
  });
  settingsModal.classList.add("hidden");
  toast("API key guardada.");
});

// ---------------- collapsible sidebar ----------------

const appEl = document.getElementById("app");
const leftSidebar = document.getElementById("sidebar-left");
const btnCollapseLeft = document.getElementById("btnCollapseLeft");

function setLeftCollapsed(collapsed) {
  leftSidebar.classList.toggle("collapsed", collapsed);
  appEl.classList.toggle("collapse-left", collapsed);
  localStorage.setItem("leftCollapsed", collapsed ? "1" : "0");
}

btnCollapseLeft.addEventListener("click", () => setLeftCollapsed(!leftSidebar.classList.contains("collapsed")));

setLeftCollapsed(localStorage.getItem("leftCollapsed") === "1");

// ---------------- init ----------------

(async function init() {
  updateThemeIcon();
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  await loadWatchlist();
  await selectSymbol(state.symbol);
  pollAlarmEvents();
  loadTrendScan();
  pollSaltos();
})();

})();
