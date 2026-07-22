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

  // Los primitives se repintan solos en pan/zoom/resize (parte del ciclo normal del chart);
  // no hace falta reposicionar nada a mano como con el enfoque anterior de divs superpuestos.
  new ResizeObserver(() => chart.timeScale().fitContent()).observe(container);

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

const DRAW_COLOR = "#2962ff"; // azul por defecto de TradingView
let activeDrag = null; // solo puede haber un arrastre a la vez en toda la página

function drawHandle(ctx, x, y, scope, square) {
  const r = 5 * scope.horizontalPixelRatio;
  ctx.beginPath();
  if (square) ctx.rect(x - r, y - r, r * 2, r * 2);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = square ? "#facc15" : DRAW_COLOR;
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
        drawHandle(ctx, x1, y1, scope, false);
        drawHandle(ctx, x2, y2, scope, false);
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
    const y1 = series.priceToCoordinate(this._source.p1.price);
    const y2 = series.priceToCoordinate(this._source.p2.price);
    const x1 = chart.timeScale().timeToCoordinate(this._source.p1.time);
    const x2 = chart.timeScale().timeToCoordinate(this._source.p2.time);
    this._p1px = { x: x1, y: y1 };
    this._p2px = { x: x2, y: y2 };
  }
  renderer() { return new TrendLinePaneRenderer(this._p1px, this._p2px, this._source.options); }
}

class TrendLinePrimitive {
  constructor(p1, p2, options) {
    this.p1 = p1;
    this.p2 = p2;
    this.options = { color: DRAW_COLOR, width: 2, selected: false, dashed: false, ...options };
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

function pixelX(pane, time) { return pane.chart.timeScale().timeToCoordinate(time); }
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
    const x1 = pixelX(pane, p.p1.time), y1 = pixelY(pane, p.p1.price);
    const x2 = pixelX(pane, p.p2.time), y2 = pixelY(pane, p.p2.price);
    if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
    const dist = distToSegment(x, y, x1, y1, x2, y2);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best;
}

function hitTestHandle(pane, id, x, y) {
  const p = pane.trendPrimitives.find((pp) => pp.__drawingId === id);
  if (!p) return null;
  const x1 = pixelX(pane, p.p1.time), y1 = pixelY(pane, p.p1.price);
  const x2 = pixelX(pane, p.p2.time), y2 = pixelY(pane, p.p2.price);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  const R = 10;
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
  await api(`/api/drawings/${id}`, { method: "DELETE" });
  if (pane.selectedDrawingId === id) pane.selectedDrawingId = null;
  await loadDrawings(pane);
}

function startDrag(pane, e, id, mode) {
  const rect = pane.container.getBoundingClientRect();
  const p = pane.trendPrimitives.find((pp) => pp.__drawingId === id);
  const drag = { pane, id, mode, rect, p };
  if (mode === "move") {
    drag.origPix1 = { x: pixelX(pane, p.p1.time), y: pixelY(pane, p.p1.price) };
    drag.origPix2 = { x: pixelX(pane, p.p2.time), y: pixelY(pane, p.p2.price) };
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

  if (drag.mode === "p1" || drag.mode === "p2") {
    const time = clampedTimeFromX(pane, x);
    const price = clampedPriceFromY(pane, y);
    if (time == null || price == null) return;
    if (drag.mode === "p1") p.setPoints({ time, price }, p.p2);
    else p.setPoints(p.p1, { time, price });
  } else if (drag.mode === "move") {
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const t1 = clampedTimeFromX(pane, drag.origPix1.x + dx);
    const pr1 = clampedPriceFromY(pane, drag.origPix1.y + dy);
    const t2 = clampedTimeFromX(pane, drag.origPix2.x + dx);
    const pr2 = clampedPriceFromY(pane, drag.origPix2.y + dy);
    if (t1 == null || pr1 == null || t2 == null || pr2 == null) return;
    p.setPoints({ time: t1, price: pr1 }, { time: t2, price: pr2 });
  }
}

async function onDragEnd() {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  const drag = activeDrag;
  activeDrag = null;
  if (!drag) return;
  try {
    await api(`/api/drawings/${drag.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { p1: drag.p.p1, p2: drag.p.p2, color: drag.p.options.color } }),
    });
  } catch (e) { toast("Error al guardar la línea: " + e.message); }
}

function clearPreview(pane) {
  if (pane.previewPrimitive) { pane.candleSeries.detachPrimitive(pane.previewPrimitive); pane.previewPrimitive = null; }
}

function setDrawMode(pane, armed) {
  pane.drawMode = armed;
  pane.pendingPoint = null;
  clearPreview(pane);
  deselectDrawing(pane);
  pane.container.classList.toggle("drawing-armed", armed);
  const btn = document.querySelector(`.btn-toggle-trend[data-pane="${pane.letter}"]`);
  if (btn) btn.classList.toggle("active", armed);
  // Mientras se traza, se desactiva el paneo/zoom: si no, un clic con el más mínimo
  // movimiento del mouse se interpreta como arrastre de la vista en vez de un clic.
  pane.chart.applyOptions({ handleScroll: !armed, handleScale: !armed });
}

function clearDrawingSeries(pane) {
  pane.trendPrimitives.forEach((p) => pane.candleSeries.detachPrimitive(p));
  pane.trendPrimitives = [];
  deselectDrawing(pane);
}

function renderDrawing(pane, d) {
  const primitive = new TrendLinePrimitive(d.data.p1, d.data.p2, { color: d.data.color || DRAW_COLOR });
  primitive.__drawingId = d.id;
  pane.candleSeries.attachPrimitive(primitive);
  pane.trendPrimitives.push(primitive);
}

async function loadDrawings(pane) {
  clearDrawingSeries(pane);
  pane.drawings = await api(`/api/drawings/${state.symbol}/${pane.interval}`);
  pane.drawings.forEach((d) => renderDrawing(pane, d));
}

function setupDrawingTool(pane) {
  const btn = document.querySelector(`.btn-toggle-trend[data-pane="${pane.letter}"]`);
  btn.addEventListener("click", () => setDrawMode(pane, !pane.drawMode));

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

    if (!pane.pendingPoint) {
      pane.pendingPoint = { time: param.time, price };
    } else {
      const p1 = pane.pendingPoint;
      const p2 = { time: param.time, price };
      pane.pendingPoint = null;
      clearPreview(pane);
      api("/api/drawings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: state.symbol, interval: pane.interval, type: "trend",
          data: { p1, p2, color: DRAW_COLOR },
        }),
      }).then(() => loadDrawings(pane));
      setDrawMode(pane, false);
    }
  });

  pane.chart.subscribeCrosshairMove((param) => {
    if (!pane.drawMode || !pane.pendingPoint || !param.point || !param.time) return;
    const price = pane.candleSeries.coordinateToPrice(param.point.y);
    if (price == null) return;
    if (!pane.previewPrimitive) {
      pane.previewPrimitive = new TrendLinePrimitive(pane.pendingPoint, { time: param.time, price }, { dashed: true });
      pane.candleSeries.attachPrimitive(pane.previewPrimitive);
    } else {
      pane.previewPrimitive.setPoints(pane.pendingPoint, { time: param.time, price });
    }
  });
}

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  if (e.key === "Escape") {
    Object.values(panes).forEach((p) => { if (p.drawMode) setDrawMode(p, false); });
  } else if (e.key === "Delete") {
    Object.values(panes).forEach((p) => {
      if (p.selectedDrawingId != null) deleteDrawing(p, p.selectedDrawingId);
    });
  }
});

// ---------------- symbol / interval loading ----------------

async function loadCandles(pane, forceRefresh) {
  const qs = forceRefresh ? "?refresh=true" : "";
  pane.candles = await api(`/api/candles/${state.symbol}/${pane.interval}${qs}`);
  pane.candleSeries.setData(pane.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  pane.chart.timeScale().fitContent();
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
  document.getElementById("alarmSymbolLabel").textContent = state.symbol;
  await Promise.all([
    loadCandles(panes.A), loadCandles(panes.B),
    loadMAConfig(), loadAlarms(), loadEarnings(), loadNews(), loadTargetPrice(), loadDailyReference(),
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
  requestAnimationFrame(() => Object.values(panes).forEach((p) => p.chart.timeScale().fitContent()));
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

const SALTO_BADGES = {
  consolidado: { cls: "consolidado", text: "consolidado" },
  sin_salto: { cls: "sin-salto", text: "sin salto" },
  salto_alza: { cls: "alza", text: "SALTO ↑ → PUT" },
  salto_baja: { cls: "baja", text: "SALTO ↓ → CALL" },
};

function renderSaltos(st) {
  const list = document.getElementById("saltosList");
  const hint = document.getElementById("saltosEmptyHint");
  const statusEl = document.getElementById("saltosStatus");
  const tickers = Object.keys(st.candidates || {});
  const phaseText = { esperando: "esperando premarket", consolidado: "consolidación detectada", evaluado: "salto evaluado" };
  statusEl.textContent = st.updated_at ? `${phaseText[st.phase] || st.phase} · ${st.updated_at}` : "sin escaneo aún";
  list.innerHTML = "";
  tickers.forEach((t) => {
    const c = st.candidates[t];
    const b = SALTO_BADGES[c.status] || SALTO_BADGES.consolidado;
    const row = document.createElement("div");
    row.className = "salto-row" + (t === state.symbol ? " active" : "");
    row.innerHTML = `
      <div class="salto-top">
        <span class="wls-ticker">${t}</span>
        <span class="salto-badge ${b.cls}">${b.text}</span>
      </div>
      <div class="salto-sub">Rango ${c.range_low.toFixed(2)}–${c.range_high.toFixed(2)} ($${c.range_size.toFixed(2)})${c.open_price != null ? ` · apertura $${c.open_price.toFixed(2)}` : ""}</div>`;
    row.addEventListener("click", () => selectSymbol(t));
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
        notifyBrowser("Salto en " + t, msg);
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

// ---------------- watchlist ----------------

async function loadWatchlist() {
  const [groups, nextMap] = await Promise.all([
    api("/api/watchlist"),
    api("/api/earnings/next-all"),
  ]);
  state.nextEarningsMap = nextMap;
  state.watchlistGroups = groups;
  const tree = document.getElementById("watchlistTree");
  tree.innerHTML = "";
  groups.forEach((g) => tree.appendChild(renderGroup(g)));
  renderFavoritesTab(groups);
}

function renderFavoritesTab(groups) {
  const favTree = document.getElementById("favoritesTree");
  const hint = document.getElementById("favoritesEmptyHint");
  favTree.innerHTML = "";
  const favorites = [];
  groups.forEach((g) => {
    const showPremarket = /etf|materia/i.test(g.name);
    g.symbols.forEach((s) => { if (s.favorite) favorites.push({ s, showPremarket }); });
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
  el.innerHTML = `
    <div class="wl-symbol-top">
      <button class="wls-fav${s.favorite ? " active" : ""}" title="${s.favorite ? "Quitar de favoritos" : "Agregar a favoritos"}"><i class="fa-solid fa-star"></i></button>
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
  el.querySelector(".wls-fav").addEventListener("click", async (e) => {
    e.stopPropagation();
    await api(`/api/watchlist/symbols/${s.id}/favorite`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite: !s.favorite }),
    });
    loadWatchlist();
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

// ---------------- alarms ----------------

async function loadAlarms() {
  state.alarms = await api(`/api/alarms?symbol=${state.symbol}`);
  const alarms = state.alarms;
  const list = document.getElementById("alarmList");
  list.innerHTML = alarms.map((a) => `
    <div class="alarm-item ${a.active ? "" : "triggered"}">
      <div class="ai-top">
        <span>${a.direction === "above"
          ? '<i class="fa-solid fa-arrow-up"></i> Cruza arriba de'
          : '<i class="fa-solid fa-arrow-down"></i> Cruza abajo de'} $${a.price}</span>
      </div>
      ${a.note ? `<div class="ai-note">${escapeHtml(a.note)}</div>` : ""}
      ${a.triggered_at ? `<div class="ai-note">Disparada el ${a.triggered_at} a $${a.triggered_price}</div>` : ""}
      <div class="ai-actions">
        ${!a.active ? `<button data-reactivate="${a.id}">Reactivar</button>` : ""}
        <button data-delalarm="${a.id}">Eliminar</button>
      </div>
    </div>`).join("") || `<p style="color:var(--text-dim);font-size:12px;">Sin alarmas para este símbolo.</p>`;

  list.querySelectorAll("[data-delalarm]").forEach((btn) => btn.addEventListener("click", async () => {
    await api(`/api/alarms/${btn.dataset.delalarm}`, { method: "DELETE" });
    loadAlarms();
  }));
  list.querySelectorAll("[data-reactivate]").forEach((btn) => btn.addEventListener("click", async () => {
    await api(`/api/alarms/${btn.dataset.reactivate}/reactivate`, { method: "POST" });
    loadAlarms();
  }));

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

document.getElementById("btnAddAlarm").addEventListener("click", async () => {
  const price = parseFloat(document.getElementById("alarmPrice").value);
  if (!price) { toast("Ingresa un precio válido."); return; }
  const direction = document.getElementById("alarmDir").value;
  const note = document.getElementById("alarmNote").value;
  await api("/api/alarms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: state.symbol, price, direction, note }),
  });
  document.getElementById("alarmPrice").value = "";
  document.getElementById("alarmNote").value = "";
  loadAlarms();
});

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

// ---------------- noticias ----------------

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 3600) return `hace ${Math.max(1, Math.round(diff / 60))} min`;
  if (diff < 86400) return `hace ${Math.round(diff / 3600)} h`;
  return `hace ${Math.round(diff / 86400)} d`;
}

async function loadNews(forceRefresh) {
  document.getElementById("newsSymbolLabel").textContent = state.symbol;
  const list = document.getElementById("newsList");
  try {
    const qs = forceRefresh ? "?refresh=true" : "";
    state.news = await api(`/api/news/${state.symbol}${qs}`);
    list.innerHTML = state.news.map((n) => `
      <a class="news-item" href="${n.link}" target="_blank" rel="noopener noreferrer">
        ${n.thumbnail ? `<img class="ni-thumb" src="${n.thumbnail}" alt="">` : `<div class="ni-thumb ni-thumb-placeholder"><i class="fa-solid fa-newspaper"></i></div>`}
        <div class="ni-body">
          <div class="ni-title">${escapeHtml(n.title_es)}</div>
          <div class="ni-meta"><span class="ni-publisher">${escapeHtml(n.publisher)}</span> · ${timeAgo(n.published_ts)}</div>
          <div class="ni-original">${escapeHtml(n.title)}</div>
        </div>
        <i class="fa-solid fa-arrow-up-right-from-square ni-ext"></i>
      </a>`).join("") ||
      `<p style="color:var(--text-dim);font-size:12px;">Sin noticias en las últimas 24 horas para ${state.symbol}.</p>`;
  } catch (e) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:12px;">Error al cargar noticias: ${e.message}</p>`;
  }
}

document.getElementById("btnRefreshNews").addEventListener("click", () => loadNews(true));

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

// ---------------- collapsible sidebars ----------------

const appEl = document.getElementById("app");
const leftSidebar = document.getElementById("sidebar-left");
const rightSidebar = document.getElementById("sidebar-right");
const btnCollapseLeft = document.getElementById("btnCollapseLeft");
const btnCollapseRight = document.getElementById("btnCollapseRight");

function setLeftCollapsed(collapsed) {
  leftSidebar.classList.toggle("collapsed", collapsed);
  appEl.classList.toggle("collapse-left", collapsed);
  localStorage.setItem("leftCollapsed", collapsed ? "1" : "0");
}

function setRightCollapsed(collapsed) {
  rightSidebar.classList.toggle("collapsed", collapsed);
  appEl.classList.toggle("collapse-right", collapsed);
  localStorage.setItem("rightCollapsed", collapsed ? "1" : "0");
}

btnCollapseLeft.addEventListener("click", () => setLeftCollapsed(!leftSidebar.classList.contains("collapsed")));
btnCollapseRight.addEventListener("click", () => setRightCollapsed(!rightSidebar.classList.contains("collapsed")));

setLeftCollapsed(localStorage.getItem("leftCollapsed") === "1");
setRightCollapsed(localStorage.getItem("rightCollapsed") === "1");

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
