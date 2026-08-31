/* Plataforma de Acciones — frontend */
(function () {
"use strict";

const state = {
  symbol: "",       // símbolo del panel enfocado (se resuelve al cargar la watchlist)
  activePane: "A",  // panel que recibe los cambios de símbolo de la watchlist
  theme: "dark", // la app es solo modo oscuro
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

/** Fecha ISO (AAAA-MM-DD) al formato dd/mm/aa que se usa en todo el panel. */
function fechaCorta(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a.slice(2)}`;
}

document.documentElement.setAttribute("data-theme", state.theme);

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
// Grosor de línea para tendencias y rayos: 1 o 2 px (preferencia local).
const getDrawWidth = () => (parseInt(localStorage.getItem("drawWidth"), 10) === 1 ? 1 : 2);
const setDrawWidthPref = (w) => localStorage.setItem("drawWidth", String(w));

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

// Colores de velas al estilo TC2000: verde y rojo puros, cuerpo sólido, mecha del mismo color.
const CANDLE_UP = "#00ff00";
const CANDLE_DOWN = "#ff0000";

// Genera el DOM de un panel (barra de herramientas + contenedor del gráfico).
// Todos los paneles nacen en M15 con solo Bandas de Bollinger activas.
function buildPaneDom(letter) {
  const div = document.createElement("div");
  div.className = "chart-pane";
  div.id = `pane${letter}`;
  div.innerHTML = `
    <div class="pane-toolbar">
      <span class="pane-symbol-label" data-pane="${letter}">—</span>
      <button class="btn-sync-symbol tool-btn" data-pane="${letter}" title="Poner este activo en todos los paneles"><i class="fa-solid fa-clone"></i></button>
      <div class="intervals" data-pane="${letter}">
        <button data-interval="m2" class="ivl-btn">M2</button>
        <button data-interval="m3" class="ivl-btn">M3</button>
        <button data-interval="m5" class="ivl-btn">M5</button>
        <button data-interval="m10" class="ivl-btn">M10</button>
        <button data-interval="m15" class="ivl-btn active">M15</button>
        <button data-interval="1h" class="ivl-btn">1H</button>
        <button data-interval="4h" class="ivl-btn">4H</button>
        <button data-interval="1d" class="ivl-btn">D1</button>
        <button data-interval="1w" class="ivl-btn">W</button>
      </div>
      <button class="btn-refresh-pane tool-btn" data-pane="${letter}" title="Actualizar gráfico"><i class="fa-solid fa-arrows-rotate"></i></button>
      <button class="btn-toggle-trend tool-btn" data-pane="${letter}" title="Línea de tendencia (dos clics)"><i class="fa-solid fa-slash"></i></button>
      <button class="btn-toggle-hline tool-btn" data-pane="${letter}" title="Línea horizontal con precio (un clic)"><svg class="tool-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="2" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="2.6" fill="var(--bg-panel-2)"/></svg></button>
      <button class="btn-toggle-hray tool-btn" data-pane="${letter}" title="Rayo horizontal con precio (un clic)"><svg class="tool-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="5" y1="12" x2="22" y2="12"/><circle cx="4" cy="12" r="2.6" fill="var(--bg-panel-2)"/></svg></button>
      <button class="btn-toggle-vline tool-btn" data-pane="${letter}" title="Línea vertical (un clic)"><svg class="tool-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><line x1="12" y1="2" x2="12" y2="22"/><circle cx="12" cy="12" r="2.6" fill="var(--bg-panel-2)"/></svg></button>
      <button class="btn-toggle-rect tool-btn" data-pane="${letter}" title="Rectángulo (dos clics)"><svg class="tool-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="14" height="14"/><circle cx="5" cy="5" r="2.2" fill="var(--bg-panel-2)"/><circle cx="19" cy="5" r="2.2" fill="var(--bg-panel-2)"/><circle cx="5" cy="19" r="2.2" fill="var(--bg-panel-2)"/><circle cx="19" cy="19" r="2.2" fill="var(--bg-panel-2)"/></svg></button>
      <button class="btn-auto-channel tool-btn" data-pane="${letter}" title="Canal automático (sobre las velas visibles)"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
      <button class="btn-clear-drawings tool-btn" data-pane="${letter}" title="Borrar todos los dibujos del símbolo"><i class="fa-solid fa-trash"></i></button>
      <button class="btn-draw-width tool-btn" data-pane="${letter}" title="Grosor de línea"><span class="width-sample"></span></button>
      <div class="color-picker-wrap" data-pane="${letter}">
        <button class="btn-draw-color tool-btn" title="Color de dibujo"><span class="color-dot"></span></button>
        <div class="color-menu hidden"></div>
      </div>
      <span class="spacer"></span>
      <button class="btn-toggle-ma tool-btn" data-pane="${letter}" title="Mostrar/ocultar medias móviles"><i class="fa-solid fa-wave-square"></i></button>
      <button class="btn-toggle-dma tool-btn" data-pane="${letter}" title="Medias fijas de una temporalidad mayor">D1</button>
      <button class="btn-toggle-bb tool-btn active" data-pane="${letter}" title="Mostrar/ocultar Bandas de Bollinger"><i class="fa-solid fa-water"></i></button>
      <button class="btn-toggle-stoch tool-btn" data-pane="${letter}" title="Panel inferior: Worden Stochastics 12 %K 3 + Volumen"><i class="fa-solid fa-chart-column"></i></button>
    </div>
    <div class="pane-chart-container" id="chartContainer${letter}">
      <div class="candle-countdown" id="countdown${letter}"></div>
    </div>`;
  document.getElementById("chartPanes").appendChild(div);
  return div;
}

function createPane(letter, defaultInterval) {
  const paneDiv = buildPaneDom(letter);
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

  // Paleta de velas estilo TC2000: verde y rojo puros, cuerpo sólido, mecha del mismo color.
  const candleSeries = chart.addSeries(LC.CandlestickSeries, {
    upColor: CANDLE_UP, downColor: CANDLE_DOWN, borderVisible: false,
    wickUpColor: CANDLE_UP, wickDownColor: CANDLE_DOWN,
  });

  const earningsMarkersPrimitive = LC.createSeriesMarkers(candleSeries, []);

  // Marca de agua con el nombre del activo, tenue en blanco, como TC2000.
  let watermark = null;
  try {
    watermark = LC.createTextWatermark(chart.panes()[0], {
      horzAlign: "center", vertAlign: "center",
      lines: [
        { text: "", color: "rgba(255,255,255,0.10)", fontSize: 56, fontStyle: "bold" },
        { text: "", color: "rgba(255,255,255,0.07)", fontSize: 20 },
      ],
    });
  } catch (_) {}

  const pane = {
    letter, container, chart, candleSeries, earningsMarkersPrimitive, watermark,
    symbol: state.symbol,
    maSeries: [], maVisible: false, bbSeries: [], bbVisible: true, dailyMaLines: [],
    stochVisible: localStorage.getItem(`stochVisible:${letter}`) === "1",
    volSeries: null, stochSeries: null, stochLevelSeries: [],
    // Arranca apagado; cada clic avanza en el ciclo y la elección se recuerda.
    dmaMode: localStorage.getItem(`dmaMode:${letter}`) || "",
    dmaRef: {}, // temporalidad de referencia -> velas ya descargadas
    extVisible: false, // sesión extendida (pre/post): retirada de la barra por no ser útil en valores poco líquidos
    extPrimitive: null,
    targetPriceLine: null, alarmPriceLines: [], sessionPrimitive: null, prevClose: null,
    interval: defaultInterval, candles: [],
    maConfig: [], dailyCandles: [], targetPrice: null, alarms: [], earnings: [],
    trendPrimitives: [], drawings: [], selectedDrawingId: null,
    drawMode: false, pendingPoint: null, previewPrimitive: null,
  };

  // Al cambiar el zoom o desplazarse, las medias diarias se recortan al nuevo rango
  // visible de las velas (con anti-rebote para no recalcular en cada píxel).
  let redibujoDma = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    if (!pane.dmaMode || !pane.dailyMaLines.length) return;
    clearTimeout(redibujoDma);
    redibujoDma = setTimeout(() => applyDailyMaLines(pane), 180);
  });

  // Clic en cualquier parte del panel lo convierte en el panel enfocado (el que
  // recibe los cambios de símbolo desde la lista de seguimiento).
  paneDiv.addEventListener("mousedown", () => {
    if (state.activePane !== letter) setActivePane(letter);
  });

  // autoSize se encarga del redimensionado; no se re-encuadra el histórico completo
  // para no perder el zoom en lo último del precio.
  return pane;
}

const panes = {
  A: createPane("A", "m15"), B: createPane("B", "m15"),
  C: createPane("C", "m15"), D: createPane("D", "m15"),
};
Object.values(panes).forEach((p) => setupDrawingTool(p));

function setActivePane(letter) {
  state.activePane = letter;
  state.symbol = panes[letter].symbol;
  document.querySelectorAll(".chart-pane").forEach((el) => el.classList.toggle("focused", el.id === `pane${letter}`));
  document.querySelectorAll(".wl-symbol").forEach((el) => el.classList.toggle("active", el.dataset.ticker === state.symbol));
  updateCurrentPrice();
}

function applyChartTheme() {
  const dark = true;
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

  pane.maConfig.forEach((ma) => {
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

// Referencia fija del nivel de las MAs de D1 en paneles intradía (M15/1H), con línea
// punteada para distinguirlas de las MAs nativas de esa temporalidad.
// Las medias del diario proyectadas sobre la temporalidad menor: cada vela intradía
// toma el valor que tenía la MA diaria en SU día, de modo que se ve la curva completa
// (escalonada, un tramo por día) y no solo el nivel actual. Se dibujan punteadas para
// distinguirlas de las MAs propias de la temporalidad.
// Temporalidades de referencia que puede fijar el botón. En M5 y M2 el ciclo
// añade H1 y M15, porque a ese detalle las medias diarias quedan muy lejos.
const DMA_CICLO = ["", "1d", "1h", "m15"];
const DMA_CICLO_CORTO = ["", "1d"];
const DMA_ETIQUETA = { "1d": "D1", "1h": "H1", m15: "M15" };
// Segundos que abarca cada vela de la referencia, para agrupar las intradía.
const DMA_TRAMO = { "1h": 3600, m15: 900 };

function dmaCiclo(pane) {
  return ["m5", "m3", "m2"].includes(pane.interval) ? DMA_CICLO : DMA_CICLO_CORTO;
}

/** Modo válido en esta temporalidad: fuera de M5/M2 solo existe D1. */
function dmaModoValido(pane) {
  return dmaCiclo(pane).includes(pane.dmaMode) ? pane.dmaMode : (pane.dmaMode ? "1d" : "");
}

function applyDailyMaLines(pane) {
  pane.dailyMaLines.forEach((s) => { try { pane.chart.removeSeries(s); } catch (_) {} });
  pane.dailyMaLines = [];
  const intradia = ["m2", "m3", "m5", "m10", "m15", "1h", "4h"].includes(pane.interval);
  const modo = dmaModoValido(pane);
  if (!intradia || !modo || !pane.candles.length) return;

  // Velas de la referencia: las diarias ya cargadas, o las de H1/M15 pedidas aparte.
  const ref = modo === "1d" ? pane.dailyCandles : pane.dmaRef[modo];
  if (!ref || !ref.length) return;

  const closes = ref.map((c) => c.close);
  // Clave del tramo (día, hora o cuarto de hora) -> valor de cada media en él.
  const tramo = DMA_TRAMO[modo];
  const claveDe = tramo ? (t) => Math.floor(t / tramo) : dayKeyOf;
  const dayKeys = ref.map((c) => claveDe(c.time));

  // Límites del recorte: el rango de las velas que se están viendo, con un pequeño
  // margen para que las medias fuera de rango queden justo en el borde.
  const vr = pane.chart.timeScale().getVisibleLogicalRange();
  const desde = vr ? Math.max(0, Math.floor(vr.from)) : 0;
  const hasta = vr ? Math.min(pane.candles.length - 1, Math.ceil(vr.to)) : pane.candles.length - 1;
  let vmin = Infinity, vmax = -Infinity;
  for (let i = desde; i <= hasta; i++) {
    const c = pane.candles[i];
    if (!c) continue;
    if (c.low < vmin) vmin = c.low;
    if (c.high > vmax) vmax = c.high;
  }
  if (!isFinite(vmin) || !isFinite(vmax)) { vmin = 0; vmax = Infinity; }
  const margen = (vmax - vmin) * 0.02 || 0;
  const suelo = vmin - margen, techo = vmax + margen;

  pane.maConfig.forEach((ma) => {
    if (!ma.enabled) return;
    const values = ma.type === "EMA" ? ema(closes, ma.period) : sma(closes, ma.period);
    const porDia = new Map();
    for (let i = 0; i < values.length; i++) {
      if (values[i] != null) porDia.set(dayKeys[i], values[i]);
    }
    if (!porDia.size) return;

    // Se recortan al rango de las velas visibles: así una media diaria lejana se ve
    // pegada al borde en vez de estirar la escala y aplastar las velas.
    const data = [];
    for (const c of pane.candles) {
      const v = porDia.get(claveDe(c.time));
      if (v != null) data.push({ time: c.time, value: Math.min(techo, Math.max(suelo, v)) });
    }
    if (!data.length) return;

    const series = pane.chart.addSeries(LC.LineSeries, {
      color: ma.color, lineWidth: 1, lineStyle: LC.LineStyle.Dotted,
      visible: true, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    series.setData(data);
    pane.dailyMaLines.push(series);
  });
}

async function loadDailyReference(pane) {
  try {
    pane.dailyCandles = await api(`/api/candles/${pane.symbol}/1d`);
  } catch (_) {
    pane.dailyCandles = [];
  }
  applyDailyMaLines(pane);
}

/** Descarga la referencia H1/M15 la primera vez que se pide para este símbolo. */
async function ensureDmaRef(pane) {
  const modo = dmaModoValido(pane);
  if (!modo || modo === "1d" || pane.dmaRef[modo]) return;
  try {
    pane.dmaRef[modo] = await api(`/api/candles/${pane.symbol}/${modo}`);
  } catch (_) {
    pane.dmaRef[modo] = [];
  }
}

/** Refresca las medias fijas, trayendo antes la referencia si hace falta. */
async function refreshDma(pane) {
  await ensureDmaRef(pane);
  applyDailyMaLines(pane);
}

/** Texto y estado del botón según el modo activo en esta temporalidad. */
function pintarBotonDma(pane) {
  const btn = document.querySelector(`.btn-toggle-dma[data-pane="${pane.letter}"]`);
  if (!btn) return;
  const modo = dmaModoValido(pane);
  // Apagado: se muestra la siguiente referencia del ciclo, para saber qué se activará.
  btn.textContent = DMA_ETIQUETA[modo] || DMA_ETIQUETA[dmaCiclo(pane)[1]];
  btn.classList.toggle("active", !!modo);
  btn.title = modo
    ? `Medias fijas de ${DMA_ETIQUETA[modo]} (clic para cambiar de referencia)`
    : "Mostrar las medias fijas de una temporalidad mayor";
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

// ---------------- panel inferior: Worden Stochastics 12 %K 3 + Volumen (estilo TC2000) ----------------
// Worden Stochastics = %K estocástico de período 12 (posición del cierre dentro del rango
// alto-bajo de las últimas 12 velas, 0-100) suavizado con SMA de 3. Se pinta amarillo con
// niveles 20/80, y el volumen debajo como barras verdes/rojas según el color de la vela.

function wordenStochastics(candles, period, smooth) {
  const rawK = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    rawK[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1 + smooth - 1; i < candles.length; i++) {
    let s = 0, n = 0;
    for (let j = i - smooth + 1; j <= i; j++) { if (rawK[j] != null) { s += rawK[j]; n++; } }
    out[i] = n ? s / n : null;
  }
  return out;
}

const STOCH_PANE = 1; // índice del subpanel en el chart

function clearStochPane(pane) {
  if (pane.volSeries) { try { pane.chart.removeSeries(pane.volSeries); } catch (_) {} pane.volSeries = null; }
  if (pane.stochSeries) { try { pane.chart.removeSeries(pane.stochSeries); } catch (_) {} pane.stochSeries = null; }
  pane.stochLevelSeries.forEach((s) => { try { pane.chart.removeSeries(s); } catch (_) {} });
  pane.stochLevelSeries = [];
}

function renderStochPane(pane) {
  clearStochPane(pane);
  if (!pane.stochVisible || !pane.candles.length) return;
  const c = pane.candles;
  const times = c.map((k) => k.time);

  // Volumen: barras verde/rojo (según cierre vs apertura) en su propia escala oculta,
  // SUPERPUESTAS con el estocástico (como TC2000): ambos ocupan todo el subpanel y las
  // barras crecen desde abajo por detrás de la línea amarilla.
  // El volumen se expresa en la MISMA escala 0-100 del estocástico, medido contra su
  // media móvil de 20: 20 en la escala = volumen medio. Así la altura de cada barra es
  // absoluta y no cambia con el zoom (antes se reescalaba al máximo visible, y la misma
  // barra cruzaba o no la línea roja según cuántas velas hubiera en pantalla).
  const volAvgPeriod = 20;
  const volLevel = c.map((k, i) => {
    const from = Math.max(0, i - volAvgPeriod + 1);
    let sum = 0, n = 0;
    for (let j = from; j <= i; j++) { sum += c[j].volume || 0; n++; }
    const avg = n ? sum / n : 0;
    // volumen medio -> nivel 20 (la línea roja); se recorta a 100 para no salirse.
    return avg > 0 ? Math.min(100, (k.volume || 0) / avg * 20) : 0;
  });
  const vol = pane.chart.addSeries(LC.HistogramSeries, {
    priceScaleId: "right", priceLineVisible: false, lastValueVisible: false,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
  }, STOCH_PANE);
  vol.setData(c.map((k, i) => ({
    time: k.time, value: volLevel[i],
    color: k.close >= k.open ? "rgba(0,255,0,0.55)" : "rgba(255,0,0,0.55)",
  })));
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
  pane.volSeries = vol;

  // Worden Stochastics 12 %K 3 (amarillo), escala 0-100 fija con niveles 20 y 80.
  const k = wordenStochastics(c, 12, 3);
  // El estocástico ocupa TODO el alto del subpanel (0-100), superpuesto al volumen.
  const stochScale = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
  const stoch = pane.chart.addSeries(LC.LineSeries, {
    color: "#ffff00", lineWidth: 1, priceScaleId: "right",
    priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    autoscaleInfoProvider: stochScale,
    priceFormat: { type: "custom", minMove: 1, formatter: (v) => Math.round(v).toString() },
  }, STOCH_PANE);
  const data = [];
  for (let i = 0; i < k.length; i++) if (k[i] != null) data.push({ time: times[i], value: k[i] });
  stoch.setData(data);
  stoch.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
  pane.stochSeries = stoch;

  [20, 80].forEach((lvl) => {
    const s = pane.chart.addSeries(LC.LineSeries, {
      color: lvl === 80 ? "rgba(0,200,0,0.7)" : "rgba(220,60,60,0.7)", lineWidth: 1, priceScaleId: "right",
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: stochScale,
    }, STOCH_PANE);
    s.setData([{ time: times[0], value: lvl }, { time: times[times.length - 1], value: lvl }]);
    pane.stochLevelSeries.push(s);
  });

  // Altura del subpanel: ~28 % del gráfico.
  try {
    const panesArr = pane.chart.panes();
    if (panesArr[STOCH_PANE]) panesArr[STOCH_PANE].setStretchFactor(0.4);
    if (panesArr[0]) panesArr[0].setStretchFactor(1);
  } catch (_) {}
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

// ---- rectángulo: dos esquinas opuestas, borde fino y relleno translúcido ----

function colorWithAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

class RectPaneRenderer {
  constructor(p1, p2, options) { this._p1 = p1; this._p2 = p2; this._options = options; }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const p1 = this._p1, p2 = this._p2, o = this._options;
      if (p1.x == null || p1.y == null || p2.x == null || p2.y == null) return;
      const ctx = scope.context;
      const x1 = p1.x * scope.horizontalPixelRatio, y1 = p1.y * scope.verticalPixelRatio;
      const x2 = p2.x * scope.horizontalPixelRatio, y2 = p2.y * scope.verticalPixelRatio;
      const x = Math.min(x1, x2), y = Math.min(y1, y2);
      const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      ctx.save();
      ctx.fillStyle = colorWithAlpha(o.color, 0.12);
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = (o.selected ? o.width + 1 : o.width) * scope.horizontalPixelRatio;
      ctx.strokeStyle = o.color;
      if (o.dashed) ctx.setLineDash([6 * scope.horizontalPixelRatio, 4 * scope.horizontalPixelRatio]);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
      if (o.selected) {
        drawHandle(ctx, x1, y1, scope, false, o.color);
        drawHandle(ctx, x2, y2, scope, false, o.color);
        drawHandle(ctx, (x1 + x2) / 2, (y1 + y2) / 2, scope, true);
      }
    });
  }
}

class RectPaneView {
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
  renderer() { return new RectPaneRenderer(this._p1px, this._p2px, this._source.options); }
}

class RectPrimitive {
  constructor(pane, p1, p2, options) {
    this._pane = pane;
    this.p1 = p1;
    this.p2 = p2;
    this.options = { color: getDrawColor(), width: 1, selected: false, dashed: false, ...options };
    this._paneView = new RectPaneView(this);
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

// Etiqueta con el precio sobre la línea, como en TC2000.
// Precio sobre la línea, alineado a la DERECHA del gráfico y sin marco (como TC2000).
function drawPriceTag(ctx, x, y, scope, price, color) {
  const hpr = scope.horizontalPixelRatio, vpr = scope.verticalPixelRatio;
  const text = price.toFixed(2);
  ctx.save();
  ctx.font = `${11 * hpr}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, scope.bitmapSize.width - 6 * hpr, y - 3 * vpr);
  ctx.restore();
}

class VLinePaneRenderer {
  constructor(p, options) { this._p = p; this._options = options; }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const p = this._p, o = this._options;
      if (p.x == null) return;
      const ctx = scope.context;
      const x = p.x * scope.horizontalPixelRatio;
      if (x < 0 || x > scope.bitmapSize.width) return;
      ctx.save();
      ctx.lineWidth = (o.selected ? o.width + 1 : o.width) * scope.horizontalPixelRatio;
      ctx.strokeStyle = o.color;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, scope.bitmapSize.height); ctx.stroke();
      ctx.restore();
      if (o.selected && p.y != null) drawHandle(ctx, x, p.y * scope.verticalPixelRatio, scope, false, o.color);
    });
  }
}

class VLinePaneView {
  constructor(source) { this._source = source; this._ppx = { x: null, y: null }; }
  update(chart, series) {
    if (!chart || !series) return;
    this._ppx = {
      x: timeToX(this._source._pane, this._source.p1.time),
      y: series.priceToCoordinate(this._source.p1.price),
    };
  }
  renderer() { return new VLinePaneRenderer(this._ppx, this._source.options); }
}

class VLinePrimitive {
  constructor(pane, p1, options) {
    this._pane = pane;
    this.p1 = p1;
    this.options = { color: getDrawColor(), width: 1, selected: false, ...options };
    this._paneView = new VLinePaneView(this);
    this._chart = null; this._series = null; this._requestUpdateFn = null;
  }
  attached(param) {
    this._chart = param.chart; this._series = param.series;
    this._requestUpdateFn = param.requestUpdate; this.requestUpdate();
  }
  detached() { this._chart = null; this._series = null; this._requestUpdateFn = null; }
  updateAllViews() { this._paneView.update(this._chart, this._series); }
  paneViews() { return [this._paneView]; }
  requestUpdate() { if (this._requestUpdateFn) this._requestUpdateFn(); }
  setPoints(p1) { this.p1 = p1; this.requestUpdate(); }
  setSelected(sel) { this.options.selected = sel; this.requestUpdate(); }
}

class HRayPaneRenderer {
  constructor(p, options) { this._p = p; this._options = options; }
  draw(target) {
    target.useBitmapCoordinateSpace((scope) => {
      const p = this._p, o = this._options;
      if (p.x == null || p.y == null) return;
      const ctx = scope.context;
      // La línea horizontal completa cruza todo el gráfico; el rayo arranca en su punto.
      const x = o.full ? 0 : p.x * scope.horizontalPixelRatio;
      const y = p.y * scope.verticalPixelRatio;
      if (!o.full && x > scope.bitmapSize.width) return;
      ctx.save();
      ctx.lineWidth = (o.selected ? o.width + 1 : o.width) * scope.horizontalPixelRatio;
      ctx.strokeStyle = o.color;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(scope.bitmapSize.width, y); ctx.stroke();
      ctx.restore();
      if (o.price != null) drawPriceTag(ctx, x, y, scope, o.price, o.color);
      if (o.selected) drawHandle(ctx, o.full ? p.x * scope.horizontalPixelRatio : x, y, scope, false, o.color);
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
  renderer() {
    return new HRayPaneRenderer(this._ppx, {
      ...this._source.options, price: this._source.p1.price,
    });
  }
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

// Tiempo del punto clicado. A la derecha de la última vela (margen del gráfico)
// la librería entrega time=null y el clic se perdía — la línea "no se terminaba".
// Aquí se extrapola el tiempo desde la coordenada X, lo que además permite
// proyectar dibujos hacia el futuro, como en TradingView.
function timeFromPoint(pane, param) {
  if (param.time) return param.time;
  if (!param.point) return null;
  const c = pane.candles;
  if (c.length < 2) return null;
  const ts = pane.chart.timeScale();
  const xLast = ts.timeToCoordinate(c[c.length - 1].time);
  if (xLast == null) return null;
  const bs = ts.options().barSpacing || 6;
  const step = (c[c.length - 1].time - c[c.length - 2].time) || 1;
  const bars = Math.round((param.point.x - xLast) / bs);
  return c[c.length - 1].time + bars * step;
}

function clampedTimeFromX(pane, x) {
  const w = pane.container.clientWidth;
  const cx = Math.max(0, Math.min(w, x));
  const t = pane.chart.timeScale().coordinateToTime(cx);
  if (t != null) return t;
  // más allá de la última vela: extrapola (permite arrastrar extremos hacia el futuro)
  return timeFromPoint(pane, { point: { x: cx } });
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
    } else if (p.__type === "hline") {
      dist = Math.abs(y - y1);
    } else if (p.__type === "vline") {
      dist = Math.abs(x - x1);
    } else if (p.__type === "rect") {
      const x2 = timeToX(pane, p.p2.time), y2 = pixelY(pane, p.p2.price);
      if (x2 == null || y2 == null) continue;
      const xa = Math.min(x1, x2), xb = Math.max(x1, x2);
      const ya = Math.min(y1, y2), yb = Math.max(y1, y2);
      dist = Math.min(
        distToSegment(x, y, xa, ya, xb, ya), distToSegment(x, y, xa, yb, xb, yb),
        distToSegment(x, y, xa, ya, xa, yb), distToSegment(x, y, xb, ya, xb, yb),
      );
      // dentro del rectángulo también selecciona, pero con menor prioridad que
      // una línea que pase cerca del punto clicado
      if (x >= xa && x <= xb && y >= ya && y <= yb) dist = Math.min(dist, TOL - 1);
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
  if (p.__type === "vline") {
    if (Math.abs(x - x1) < R - 2) return "move";
    return null;
  }
  if (p.__type === "hray" || p.__type === "hline") {
    if (Math.hypot(x - x1, y - y1) < R) return "p1";
    const enRango = p.__type === "hline" || x >= x1;
    if (enRango && Math.abs(y - y1) < R - 2) return "move";
    return null;
  }
  const x2 = timeToX(pane, p.p2.time), y2 = pixelY(pane, p.p2.price);
  if (x2 == null || y2 == null) return null;
  if (Math.hypot(x - x1, y - y1) < R) return "p1";
  if (Math.hypot(x - x2, y - y2) < R) return "p2";
  if (Math.hypot(x - (x1 + x2) / 2, y - (y1 + y2) / 2) < R) return "move";
  if (p.__type === "rect") {
    // agarrar el cuerpo del rectángulo lo mueve completo
    const xa = Math.min(x1, x2), xb = Math.max(x1, x2);
    const ya = Math.min(y1, y2), yb = Math.max(y1, y2);
    if (x >= xa && x <= xb && y >= ya && y <= yb) return "move";
  }
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
  const arr = getSymbolDrawings(pane.symbol).filter((d) => d.id !== id);
  setSymbolDrawings(pane.symbol, arr);
  if (pane.selectedDrawingId === id) pane.selectedDrawingId = null;
  loadAllDrawings();
}

function startDrag(pane, e, id, mode) {
  const rect = pane.container.getBoundingClientRect();
  const p = pane.trendPrimitives.find((pp) => pp.__drawingId === id);
  const drag = { pane, id, mode, rect, p };
  if (mode === "move") {
    drag.origPix1 = { x: timeToX(pane, p.p1.time), y: pixelY(pane, p.p1.price) };
    if (p.__type !== "hray" && p.__type !== "hline" && p.__type !== "vline") drag.origPix2 = { x: timeToX(pane, p.p2.time), y: pixelY(pane, p.p2.price) };
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
  const isRay = p.__type === "hray" || p.__type === "hline" || p.__type === "vline";

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
  const arr = getSymbolDrawings(drag.pane.symbol);
  const rec = arr.find((d) => d.id === drag.id);
  if (rec) {
    const base = { color: drag.p.options.color, width: drag.p.options.width };
    rec.data = (drag.p.__type === "hray" || drag.p.__type === "hline" || drag.p.__type === "vline")
      ? { ...rec.data, ...base, p1: drag.p.p1 }
      : { ...rec.data, ...base, p1: drag.p.p1, p2: drag.p.p2 };
    setSymbolDrawings(drag.pane.symbol, arr);
  }
  // Sincroniza el mismo dibujo en los demás paneles que muestran este símbolo.
  Object.values(panes).forEach((p) => { if (p !== drag.pane && p.symbol === drag.pane.symbol) loadDrawings(p); });
}

function clearPreview(pane) {
  if (pane.previewPrimitive) { pane.candleSeries.detachPrimitive(pane.previewPrimitive); pane.previewPrimitive = null; }
}

// mode: null | "trend" (línea, 2 clics) | "hray" (rayo, 1 clic) | "rect" (rectángulo, 2 clics)
function setDrawMode(pane, mode) {
  pane.drawMode = mode || null;
  pane.pendingPoint = null;
  clearPreview(pane);
  deselectDrawing(pane);
  pane.container.classList.toggle("drawing-armed", !!mode);
  const tbtn = document.querySelector(`.btn-toggle-trend[data-pane="${pane.letter}"]`);
  const hbtn = document.querySelector(`.btn-toggle-hray[data-pane="${pane.letter}"]`);
  const lbtn = document.querySelector(`.btn-toggle-hline[data-pane="${pane.letter}"]`);
  const vbtn = document.querySelector(`.btn-toggle-vline[data-pane="${pane.letter}"]`);
  const rbtn = document.querySelector(`.btn-toggle-rect[data-pane="${pane.letter}"]`);
  if (tbtn) tbtn.classList.toggle("active", mode === "trend");
  if (hbtn) hbtn.classList.toggle("active", mode === "hray");
  if (lbtn) lbtn.classList.toggle("active", mode === "hline");
  if (vbtn) vbtn.classList.toggle("active", mode === "vline");
  if (rbtn) rbtn.classList.toggle("active", mode === "rect");
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
  const opts = { color: d.data.color || getDrawColor(), width: d.data.width || (type === "rect" ? 1 : 2) };
  const primitive = type === "vline"
    ? new VLinePrimitive(pane, d.data.p1, opts)
    : (type === "hray" || type === "hline")
    ? new HRayPrimitive(pane, d.data.p1, { ...opts, full: type === "hline" })
    : type === "rect"
      ? new RectPrimitive(pane, d.data.p1, d.data.p2, opts)
      : new TrendLinePrimitive(pane, d.data.p1, d.data.p2, opts);
  primitive.__drawingId = d.id;
  primitive.__type = type;
  pane.candleSeries.attachPrimitive(primitive);
  pane.trendPrimitives.push(primitive);
}

async function loadDrawings(pane) {
  clearDrawingSeries(pane);
  pane.drawings = getSymbolDrawings(pane.symbol);
  pane.drawings.forEach((d) => renderDrawing(pane, d));
}

// El mismo dibujo se ve en ambas pantallas: tras crear/borrar/recolorear se recargan las dos.
function loadAllDrawings() {
  Object.values(panes).forEach((p) => loadDrawings(p));
}

// Editar el precio exacto de una línea horizontal o un rayo: la línea se recoloca
// al valor tecleado, sin depender de la puntería del arrastre.
function editDrawingPrice(pane, id) {
  const arr = getSymbolDrawings(pane.symbol);
  const rec = arr.find((d) => d.id === id);
  if (!rec || (rec.type !== "hline" && rec.type !== "hray")) return false;
  const actual = rec.data.p1.price;
  const txt = prompt("Precio de la línea:", actual.toFixed(2));
  if (txt === null) return true;
  const nuevo = parseFloat(String(txt).replace(",", "."));
  if (!isFinite(nuevo)) { toast("Precio inválido."); return true; }
  rec.data.p1 = { ...rec.data.p1, price: nuevo };
  setSymbolDrawings(pane.symbol, arr);
  loadAllDrawings();
  selectDrawing(pane, id);
  return true;
}

function recolorDrawing(pane, id, color) {
  const arr = getSymbolDrawings(pane.symbol);
  const rec = arr.find((d) => d.id === id);
  if (!rec) return;
  rec.data.color = color;
  setSymbolDrawings(pane.symbol, arr);
  loadAllDrawings();
  selectDrawing(pane, id);
}

function rewidthDrawing(pane, id, width) {
  const arr = getSymbolDrawings(pane.symbol);
  const rec = arr.find((d) => d.id === id);
  if (!rec) return;
  rec.data.width = width;
  setSymbolDrawings(pane.symbol, arr);
  loadAllDrawings();
  selectDrawing(pane, id);
}

function refreshWidthBtns() {
  const w = getDrawWidth();
  document.querySelectorAll(".btn-draw-width .width-sample").forEach((s) => s.classList.toggle("w1", w === 1));
  document.querySelectorAll(".btn-draw-width").forEach((b) => { b.title = `Grosor de línea: ${w} px (clic para alternar)`; });
}

// Borra TODOS los dibujos del símbolo de ese panel (se reflejan en todos los paneles).
function clearAllDrawings(pane) {
  const arr = getSymbolDrawings(pane.symbol);
  if (!arr.length) { toast(`No hay dibujos en ${pane.symbol}.`); return; }
  if (!confirm(`¿Borrar los ${arr.length} dibujo(s) de ${pane.symbol}?`)) return;
  setSymbolDrawings(pane.symbol, []);
  loadAllDrawings();
}

// Canal automático: regresión lineal sobre las velas visibles del panel y dos
// paralelas desplazadas hasta envolver todos los máximos y mínimos del tramo
// (estilo "Regression Trend" de TradingView). Un nuevo canal de la misma
// temporalidad reemplaza al anterior; canales de D1 y H1 pueden coexistir.
function autoChannel(pane) {
  const c = pane.candles;
  if (c.length < 20) { toast("No hay suficientes velas para calcular el canal."); return; }
  let from = 0, to = c.length - 1;
  const vr = pane.chart.timeScale().getVisibleLogicalRange();
  if (vr) {
    from = Math.max(0, Math.floor(vr.from));
    to = Math.min(c.length - 1, Math.ceil(vr.to));
  }
  if (to - from < 20) from = Math.max(0, to - 20);
  const seg = c.slice(from, to + 1);
  const n = seg.length;

  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  seg.forEach((k, i) => { sx += i; sy += k.close; sxx += i * i; sxy += i * k.close; });
  const denom = n * sxx - sx * sx;
  if (!denom) return;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  let upOff = 0, downOff = 0;
  seg.forEach((k, i) => {
    const base = intercept + slope * i;
    upOff = Math.max(upOff, k.high - base);
    downOff = Math.max(downOff, base - k.low);
  });

  const t1 = seg[0].time, t2 = seg[n - 1].time;
  const y1 = intercept, y2 = intercept + slope * (n - 1);
  const color = getDrawColor();
  const width = getDrawWidth();
  const tag = `channel-${pane.interval}`;
  const arr = getSymbolDrawings(pane.symbol).filter((d) => !(d.data && d.data.auto === tag));
  arr.push(
    { id: nextDrawingId(), type: "trend", data: { p1: { time: t1, price: y1 + upOff }, p2: { time: t2, price: y2 + upOff }, color, width, auto: tag } },
    { id: nextDrawingId(), type: "trend", data: { p1: { time: t1, price: y1 - downOff }, p2: { time: t2, price: y2 - downOff }, color, width, auto: tag } },
  );
  setSymbolDrawings(pane.symbol, arr);
  loadAllDrawings();
  toast(`Canal automático sobre ${n} velas de ${pane.interval.toUpperCase()}.`);
}

function setupDrawingTool(pane) {
  const btn = document.querySelector(`.btn-toggle-trend[data-pane="${pane.letter}"]`);
  btn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "trend" ? null : "trend"));
  const hrayBtn = document.querySelector(`.btn-toggle-hray[data-pane="${pane.letter}"]`);
  hrayBtn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "hray" ? null : "hray"));
  const hlineBtn = document.querySelector(`.btn-toggle-hline[data-pane="${pane.letter}"]`);
  hlineBtn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "hline" ? null : "hline"));
  const vlineBtn = document.querySelector(`.btn-toggle-vline[data-pane="${pane.letter}"]`);
  vlineBtn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "vline" ? null : "vline"));
  const rectBtn = document.querySelector(`.btn-toggle-rect[data-pane="${pane.letter}"]`);
  rectBtn.addEventListener("click", () => setDrawMode(pane, pane.drawMode === "rect" ? null : "rect"));
  document.querySelector(`.btn-auto-channel[data-pane="${pane.letter}"]`).addEventListener("click", () => autoChannel(pane));
  document.querySelector(`.btn-clear-drawings[data-pane="${pane.letter}"]`).addEventListener("click", () => clearAllDrawings(pane));

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

  // Grosor 1/2 px: alterna la preferencia y, si hay un dibujo seleccionado, se lo aplica.
  const widthBtn = document.querySelector(`.btn-draw-width[data-pane="${pane.letter}"]`);
  widthBtn.addEventListener("click", () => {
    setDrawWidthPref(getDrawWidth() === 1 ? 2 : 1);
    refreshWidthBtns();
    if (pane.selectedDrawingId != null) rewidthDrawing(pane, pane.selectedDrawingId, getDrawWidth());
  });
  refreshWidthBtns();

  // Doble clic sobre una línea horizontal o un rayo: permite teclear su precio exacto.
  pane.container.addEventListener("dblclick", (e) => {
    const rect = pane.container.getBoundingClientRect();
    const hit = hitTestDrawings(pane, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    if (editDrawingPrice(pane, hit.__drawingId)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

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
    const time = timeFromPoint(pane, param);
    if (time == null) return;
    const price = pane.candleSeries.coordinateToPrice(param.point.y);
    if (price === null) return;

    if (pane.drawMode === "hray" || pane.drawMode === "hline" || pane.drawMode === "vline") {
      const arr = getSymbolDrawings(pane.symbol);
      arr.push({ id: nextDrawingId(), type: pane.drawMode, data: { p1: { time, price }, color: getDrawColor(), width: getDrawWidth() } });
      setSymbolDrawings(pane.symbol, arr);
      loadAllDrawings();
      setDrawMode(pane, null);
      return;
    }

    // "trend" y "rect" se trazan con dos clics (el rectángulo siempre con borde de 1 px)
    if (!pane.pendingPoint) {
      pane.pendingPoint = { time, price };
    } else {
      const p1 = pane.pendingPoint;
      const p2 = { time, price };
      const type = pane.drawMode;
      pane.pendingPoint = null;
      clearPreview(pane);
      const arr = getSymbolDrawings(pane.symbol);
      arr.push({ id: nextDrawingId(), type, data: { p1, p2, color: getDrawColor(), width: type === "rect" ? 1 : getDrawWidth() } });
      setSymbolDrawings(pane.symbol, arr);
      loadAllDrawings();
      setDrawMode(pane, null);
    }
  });

  pane.chart.subscribeCrosshairMove((param) => {
    if ((pane.drawMode !== "trend" && pane.drawMode !== "rect") || !pane.pendingPoint || !param.point) return;
    const time = timeFromPoint(pane, param);
    if (time == null) return;
    const price = pane.candleSeries.coordinateToPrice(param.point.y);
    if (price == null) return;
    if (!pane.previewPrimitive) {
      pane.previewPrimitive = pane.drawMode === "rect"
        ? new RectPrimitive(pane, pane.pendingPoint, { time, price }, { dashed: true, width: 1 })
        : new TrendLinePrimitive(pane, pane.pendingPoint, { time, price }, { dashed: true, width: getDrawWidth() });
      pane.candleSeries.attachPrimitive(pane.previewPrimitive);
    } else {
      pane.previewPrimitive.setPoints(pane.pendingPoint, { time, price });
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
function focusLatest(pane, attempt = 0) {
  const n = pane.candles.length;
  if (!n) return;
  // Si el contenedor aún no tiene tamaño real (panel recién visible / carga inicial),
  // el rango no surte efecto: se reintenta unos instantes después.
  if (pane.container.clientWidth < 50 && attempt < 20) {
    setTimeout(() => focusLatest(pane, attempt + 1), 100);
    return;
  }
  pane.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 6 });
}

// ---- sombreado de las horas de sesión extendida (pre 4:00-9:30 y post 16:00-20:00) ----
// Fondo tenue en las velas fuera de la sesión regular, como hace TC2000/TradingView,
// para distinguir a simple vista el premarket/postmarket del horario normal.
function isRegularSessionTime(t) {
  const d = new Date(t * 1000); // el epoch guardado es hora NY "naive" -> leer en UTC
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

class ExtSessionPrimitive {
  constructor(pane) { this._pane = pane; this._req = null; this._view = { update: () => {}, renderer: () => this }; }
  attached(p) { this._req = p.requestUpdate; this._req(); }
  detached() { this._req = null; }
  updateAllViews() {}
  paneViews() { return [this._view]; }
  draw(target) {
    const pane = this._pane;
    if (!pane.extVisible || pane.interval === "1d" || !pane.candles.length) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ts = pane.chart.timeScale();
      const bs = (ts.options().barSpacing || 6) * scope.horizontalPixelRatio;
      const vr = ts.getVisibleLogicalRange();
      if (!vr) return;
      const from = Math.max(0, Math.floor(vr.from)), to = Math.min(pane.candles.length - 1, Math.ceil(vr.to));
      const ctx = scope.context;
      ctx.save();
      ctx.fillStyle = "rgba(140,150,170,0.07)";
      let runStart = null;
      const flush = (endIdx) => {
        if (runStart == null) return;
        const xa = ts.timeToCoordinate(pane.candles[runStart].time), xb = ts.timeToCoordinate(pane.candles[endIdx].time);
        if (xa != null && xb != null) {
          const x0 = xa * scope.horizontalPixelRatio - bs / 2, x1 = xb * scope.horizontalPixelRatio + bs / 2;
          ctx.fillRect(x0, 0, x1 - x0, scope.bitmapSize.height);
        }
        runStart = null;
      };
      for (let i = from; i <= to; i++) {
        const ext = !isRegularSessionTime(pane.candles[i].time);
        if (ext && runStart == null) runStart = i;
        if (!ext) flush(i - 1);
      }
      flush(to);
      ctx.restore();
    });
  }
}

async function loadCandles(pane, forceRefresh) {
  const qs = forceRefresh ? "?refresh=true" : "";
  const useExt = pane.extVisible && pane.interval !== "1d";
  const url = useExt ? `/api/candles-ext/${pane.symbol}/${pane.interval}${qs}` : `/api/candles/${pane.symbol}/${pane.interval}${qs}`;
  try {
    pane.candles = await api(url);
  } catch (e) {
    if (!useExt) throw e;
    toast("Sin datos de sesión extendida; mostrando sesión regular.");
    pane.candles = await api(`/api/candles/${pane.symbol}/${pane.interval}${qs}`);
  }
  pane.candleSeries.setData(pane.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  if (!pane.extPrimitive) {
    pane.extPrimitive = new ExtSessionPrimitive(pane);
    pane.candleSeries.attachPrimitive(pane.extPrimitive);
  }
  applyPrevCloseLine(pane); // separadores de día + cierre anterior sobre el día actual
  focusLatest(pane);
  // Reactiva el auto-escalado del eje de precios: al cambiar de activo (o temporalidad)
  // el gráfico vuelve a centrarse en el nuevo rango de precios, aunque el usuario haya
  // arrastrado el eje antes (eso apaga el auto-escalado hasta que se reactiva).
  pane.candleSeries.priceScale().applyOptions({ autoScale: true });
  renderMAs(pane);
  renderBollinger(pane);
  renderStochPane(pane);
  updateEarningsMarkers(pane);
  await loadDrawings(pane);
  if (pane.letter === state.activePane) updateCurrentPrice();
}

// ---- actualización en vivo de la vela en curso ----
// Con el mercado abierto, cada panel visible vuelve a pedir sus velas periódicamente
// (el servidor decide si toca ir a la fuente según la temporalidad) y actualiza el
// gráfico SIN tocar el zoom ni la posición: solo se refrescan las velas nuevas o la
// que se está formando, como hace TC2000. Antes el gráfico era una foto estática hasta
// que se cambiaba de símbolo o se pulsaba refrescar.
const LIVE_REFRESH_MS = { m2: 15000, m3: 15000, m5: 20000, m10: 25000, m15: 30000, "1h": 60000, "4h": 120000, "1d": 120000, "1w": 300000 };

function marketOpenNowNY() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = et.getDay();
  const m = et.getHours() * 60 + et.getMinutes();
  return dow >= 1 && dow <= 5 && m >= 9 * 60 + 30 && m < 16 * 60;
}

async function liveUpdatePane(pane) {
  if (!pane.candles.length || pane.liveBusy) return;
  pane.liveBusy = true;
  try {
    const useExt = pane.extVisible && pane.interval !== "1d";
    const url = useExt ? `/api/candles-ext/${pane.symbol}/${pane.interval}` : `/api/candles/${pane.symbol}/${pane.interval}`;
    const fresh = await api(url);
    if (!fresh.length) return;
    const lastKnown = pane.candles[pane.candles.length - 1].time;
    // velas nuevas o cambiadas desde la última conocida (incluida la que se forma)
    const changed = fresh.filter((c) => c.time >= lastKnown);
    if (!changed.length) return;
    let dirty = false;
    changed.forEach((c) => {
      const i = pane.candles.findIndex((k) => k.time === c.time);
      const prev = i >= 0 ? pane.candles[i] : null;
      if (prev && prev.close === c.close && prev.high === c.high && prev.low === c.low) return;
      if (i >= 0) pane.candles[i] = c; else pane.candles.push(c);
      pane.candleSeries.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
      dirty = true;
    });
    if (!dirty) return;
    renderMAs(pane);
    renderBollinger(pane);
    renderStochPane(pane);
    applyPrevCloseLine(pane);
    if (pane.letter === state.activePane) updateCurrentPrice();
  } catch (_) {
    // silencioso: la próxima pasada lo intenta de nuevo
  } finally {
    pane.liveBusy = false;
  }
}

function liveTick() {
  const now = Date.now();
  if (marketOpenNowNY()) {
    visiblePanes().forEach((p) => {
      const every = LIVE_REFRESH_MS[p.interval] || 60000;
      if (!p.lastLive || now - p.lastLive >= every) {
        p.lastLive = now;
        liveUpdatePane(p);
      }
    });
  }
  setTimeout(liveTick, 5000);
}

async function updateCurrentPrice() {
  const fp = panes[state.activePane];
  document.getElementById("curSymbol").textContent = fp.symbol;
  const candles = fp.candles;
  if (!candles.length) return;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2].close : last.open;
  renderPrice(last.close, prev);
  try {
    const r = await api(`/api/price/${fp.symbol}`);
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

// Marca de agua: ticker grande y nombre de la empresa debajo, como TC2000.
function updateWatermark(pane) {
  if (!pane.watermark) return;
  let nombre = "";
  (state.watchlistGroups || []).forEach((g) => g.symbols.forEach((sy) => {
    if (sy.ticker === pane.symbol && sy.name) nombre = sy.name;
  }));
  try {
    pane.watermark.applyOptions({
      lines: [
        { text: pane.symbol, color: "rgba(255,255,255,0.10)", fontSize: 56, fontStyle: "bold" },
        { text: nombre, color: "rgba(255,255,255,0.07)", fontSize: 20 },
      ],
    });
  } catch (_) {}
}

// Carga todos los datos de un panel para su símbolo actual.
async function loadPaneData(pane) {
  const lbl = document.querySelector(`.pane-symbol-label[data-pane="${pane.letter}"]`);
  if (lbl) lbl.textContent = pane.symbol;
  updateWatermark(pane);
  pane.dmaRef = {}; // otro símbolo: las referencias H1/M15 en caché ya no valen
  await Promise.all([
    loadCandles(pane), loadMAConfig(pane), loadAlarms(pane), loadEarnings(pane),
    loadTargetPrice(pane), loadDailyReference(pane), loadPrevClose(pane),
  ]);
  await refreshDma(pane);
}

// Cambia el símbolo del panel ENFOCADO (clic en un panel para enfocarlo).
async function selectSymbol(ticker) {
  const pane = panes[state.activePane];
  pane.symbol = ticker.toUpperCase();
  state.symbol = pane.symbol;
  localStorage.setItem(`paneSymbol:${pane.letter}`, pane.symbol); // recordado por panel
  document.querySelectorAll(".wl-symbol").forEach((el) => el.classList.toggle("active", el.dataset.ticker === state.symbol));
  await loadPaneData(pane);
  updateCurrentPrice();
}

// Copia el activo de un panel a los demás visibles, para comparar el mismo
// símbolo en varias temporalidades sin teclearlo panel por panel.
async function sincronizarSimbolo(origen) {
  const destinos = visiblePanes().filter((p) => p !== origen && p.symbol !== origen.symbol);
  if (!destinos.length) { toast(`Todos los paneles ya muestran ${origen.symbol}.`); return; }
  await Promise.all(destinos.map(async (p) => {
    p.symbol = origen.symbol;
    localStorage.setItem(`paneSymbol:${p.letter}`, p.symbol);
    await loadPaneData(p);
    if (p.candles.length) focusLatest(p);
  }));
  toast(`${origen.symbol} en ${destinos.length + 1} paneles.`);
}

document.querySelectorAll(".btn-sync-symbol").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pane = panes[btn.dataset.pane];
    if (!pane.symbol) return;
    btn.disabled = true;
    try { await sincronizarSimbolo(pane); }
    finally { btn.disabled = false; }
  });
});

document.querySelectorAll(".btn-refresh-pane").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const pane = panes[btn.dataset.pane];
    btn.disabled = true;
    try {
      await loadCandles(pane, true);
      await refreshDma(pane);
      toast(`${pane.symbol} (${pane.interval}) actualizado con los últimos datos.`);
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
  });
});

// Panel inferior Worden Stochastics + Volumen (estilo TC2000), por panel, recordado.
document.querySelectorAll(".btn-toggle-stoch").forEach((btn) => {
  const pane = panes[btn.dataset.pane];
  btn.classList.toggle("active", pane.stochVisible);
  btn.addEventListener("click", () => {
    pane.stochVisible = !pane.stochVisible;
    localStorage.setItem(`stochVisible:${pane.letter}`, pane.stochVisible ? "1" : "0");
    btn.classList.toggle("active", pane.stochVisible);
    renderStochPane(pane);
  });
});

// Niveles de las MAs diarias (líneas punteadas D1) en paneles intradía: toggle propio,
// independiente del botón de MAs de la temporalidad, con preferencia local por panel.
document.querySelectorAll(".btn-toggle-dma").forEach((btn) => {
  const pane = panes[btn.dataset.pane];
  pintarBotonDma(pane);
  btn.addEventListener("click", async () => {
    // Cicla apagado -> D1 -> H1 -> M15 -> apagado. En M15 y superiores el ciclo
    // es solo apagado -> D1, porque ahí H1 y M15 no aportan nada nuevo.
    const ciclo = dmaCiclo(pane);
    const i = ciclo.indexOf(dmaModoValido(pane));
    pane.dmaMode = ciclo[(i + 1) % ciclo.length];
    localStorage.setItem(`dmaMode:${pane.letter}`, pane.dmaMode);
    pintarBotonDma(pane);
    await refreshDma(pane);
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
      pintarBotonDma(pane); // el ciclo disponible depende de la temporalidad
      await refreshDma(pane);
      applyPrevCloseLine(pane);
    });
  });
});

// ---------------- vista dividida (dos temporalidades) ----------------

const chartPanesEl = document.getElementById("chartPanes");
const btnSplitView = document.getElementById("btnSplitView");
// Diseños: 1 panel, 2 en fila, o 4 en cuadrícula (2 arriba y 2 abajo). El botón cicla.
const LAYOUT_ORDER = ["1", "2", "4"];
const LAYOUT_PANES = { "1": ["A"], "2": ["A", "B"], "4": ["A", "B", "C", "D"] };
let layoutMode = LAYOUT_ORDER.includes(localStorage.getItem("layoutMode")) ? localStorage.getItem("layoutMode") : "1";

function visiblePanes() { return LAYOUT_PANES[layoutMode].map((l) => panes[l]); }

function applyLayout() {
  chartPanesEl.classList.remove("layout-1", "layout-2", "layout-4");
  chartPanesEl.classList.add(`layout-${layoutMode}`);
  btnSplitView.classList.toggle("active", layoutMode !== "1");
  btnSplitView.title = `Diseño: ${layoutMode} panel(es) — clic para cambiar (1 → 2 → 4)`;
  // con un solo panel no hay a dónde copiar el activo
  document.querySelectorAll(".btn-sync-symbol").forEach((b) => b.classList.toggle("hidden", layoutMode === "1"));
  positionSplitters();
  if (!LAYOUT_PANES[layoutMode].includes(state.activePane)) setActivePane("A");
  requestAnimationFrame(() => visiblePanes().forEach((p) => focusLatest(p)));
  // Paneles recién visibles que aún no tienen datos: se cargan ahora. El enfoque a las
  // últimas velas se reaplica tras la carga, porque si el gráfico aún no tenía tamaño
  // real cuando llegaron los datos, el setVisibleLogicalRange inicial no surte efecto.
  visiblePanes().forEach((p) => {
    if (!p.candles.length) loadPaneData(p).then(() => { focusLatest(p); setTimeout(() => focusLatest(p), 400); });
  });
}

// ---- divisores arrastrables entre paneles ----
// Permiten agrandar un panel a costa del contiguo, arrastrando la línea que los separa.
// Las proporciones se guardan y se aplican con variables CSS sobre el grid.

function applySplitVars() {
  const x = parseFloat(localStorage.getItem("splitX")) || 50;
  const y = parseFloat(localStorage.getItem("splitY")) || 50;
  chartPanesEl.style.setProperty("--split-x", `${x}fr`);
  chartPanesEl.style.setProperty("--split-x2", `${100 - x}fr`);
  chartPanesEl.style.setProperty("--split-y", `${y}fr`);
  chartPanesEl.style.setProperty("--split-y2", `${100 - y}fr`);
}

function positionSplitters() {
  const vs = document.getElementById("splitterV");
  const hs = document.getElementById("splitterH");
  if (!vs || !hs) return;
  const dos = layoutMode === "2", cuatro = layoutMode === "4";
  vs.classList.toggle("hidden", !(dos || cuatro));
  hs.classList.toggle("hidden", !cuatro);
  const x = parseFloat(localStorage.getItem("splitX")) || 50;
  const y = parseFloat(localStorage.getItem("splitY")) || 50;
  vs.style.left = `${x}%`;
  hs.style.top = `${y}%`;
}

function startSplitDrag(e, eje) {
  e.preventDefault();
  const el = eje === "x" ? document.getElementById("splitterV") : document.getElementById("splitterH");
  el.classList.add("dragging");
  document.body.classList.add("splitting");
  if (eje === "y") document.body.classList.add("row");

  const mover = (ev) => {
    const r = chartPanesEl.getBoundingClientRect();
    const pct = eje === "x"
      ? ((ev.clientX - r.left) / r.width) * 100
      : ((ev.clientY - r.top) / r.height) * 100;
    const lim = Math.min(85, Math.max(15, pct)); // no dejar un panel demasiado pequeño
    localStorage.setItem(eje === "x" ? "splitX" : "splitY", String(lim));
    applySplitVars();
    positionSplitters();
  };
  const soltar = () => {
    document.removeEventListener("mousemove", mover);
    document.removeEventListener("mouseup", soltar);
    el.classList.remove("dragging");
    document.body.classList.remove("splitting", "row");
    // los gráficos cambiaron de ancho: reencuadrar las últimas velas
    requestAnimationFrame(() => visiblePanes().forEach((p) => { if (p.candles.length) focusLatest(p); }));
  };
  document.addEventListener("mousemove", mover);
  document.addEventListener("mouseup", soltar);
}

// Doble clic en el divisor: vuelve al reparto 50/50.
function resetSplit(eje) {
  localStorage.setItem(eje === "x" ? "splitX" : "splitY", "50");
  applySplitVars();
  positionSplitters();
  requestAnimationFrame(() => visiblePanes().forEach((p) => { if (p.candles.length) focusLatest(p); }));
}

(function crearSplitters() {
  const v = document.createElement("div");
  v.className = "pane-splitter vertical hidden";
  v.id = "splitterV";
  v.title = "Arrastra para agrandar un panel (doble clic: 50/50)";
  v.addEventListener("mousedown", (e) => startSplitDrag(e, "x"));
  v.addEventListener("dblclick", () => resetSplit("x"));

  const h = document.createElement("div");
  h.className = "pane-splitter horizontal hidden";
  h.id = "splitterH";
  h.title = "Arrastra para agrandar una fila (doble clic: 50/50)";
  h.addEventListener("mousedown", (e) => startSplitDrag(e, "y"));
  h.addEventListener("dblclick", () => resetSplit("y"));

  chartPanesEl.appendChild(v);
  chartPanesEl.appendChild(h);
  applySplitVars();
})();

btnSplitView.addEventListener("click", () => {
  layoutMode = LAYOUT_ORDER[(LAYOUT_ORDER.indexOf(layoutMode) + 1) % LAYOUT_ORDER.length];
  localStorage.setItem("layoutMode", layoutMode);
  applyLayout();
});

// ---------------- cuenta atrás de la vela en curso ----------------

const INTERVAL_SECONDS = { m2: 120, m3: 180, m5: 300, m10: 600, m15: 900, "1h": 3600, "4h": 14400 };

function updateCountdowns() {
  // Hora del mercado (Nueva York), con horario de verano correcto.
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dow = et.getDay();
  const secs = et.getHours() * 3600 + et.getMinutes() * 60 + et.getSeconds();
  const open = 9 * 3600 + 30 * 60, close = 16 * 3600;
  const marketOpen = dow >= 1 && dow <= 5 && secs >= open && secs < close;
  Object.values(panes).forEach((pane) => {
    const el = document.getElementById(`countdown${pane.letter}`);
    if (!el) return;
    if (!marketOpen) { el.textContent = "mercado cerrado"; return; }
    let remain;
    if (pane.interval === "1d") {
      remain = close - secs;
    } else {
      const step = INTERVAL_SECONDS[pane.interval] || 900;
      remain = Math.min(step - ((secs - open) % step), close - secs);
    }
    const h = Math.floor(remain / 3600), m = Math.floor((remain % 3600) / 60), s = remain % 60;
    el.textContent = "vela: " + (h ? `${h}:` : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  });
}
setInterval(updateCountdowns, 1000);
updateCountdowns();

// ---------------- target price (línea horizontal automática) ----------------

// ---------------- cierre de la sesión anterior (línea punteada blanca, como TC2000) ----------------

async function loadPrevClose(pane) {
  try {
    const q = await api(`/api/premarket/${pane.symbol}`);
    pane.prevClose = q && q.previous_close ? q.previous_close : null;
  } catch (_) {
    pane.prevClose = null;
  }
  applyPrevCloseLine(pane);
}

// El cierre anterior se pinta SOLO sobre el día actual (desde la primera vela de hoy
// hacia la derecha), y cada cambio de día se marca con una línea vertical: ambas cosas
// tal como las muestra TC2000. Todo en un primitive de canvas por panel.
function applyPrevCloseLine(pane) {
  if (!pane.sessionPrimitive) {
    pane.sessionPrimitive = new SessionMarksPrimitive(pane);
    pane.candleSeries.attachPrimitive(pane.sessionPrimitive);
  }
  pane.sessionPrimitive.requestUpdate();
}

function dayKeyOf(t) {
  const d = new Date(t * 1000); // epoch "naive" hora NY -> leer en UTC
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

class SessionMarksPrimitive {
  constructor(pane) { this._pane = pane; this._req = null; this._view = { update: () => {}, renderer: () => this }; }
  attached(p) { this._req = p.requestUpdate; this._req(); }
  detached() { this._req = null; }
  requestUpdate() { if (this._req) this._req(); }
  updateAllViews() {}
  paneViews() { return [this._view]; }
  draw(target) {
    const pane = this._pane;
    if (pane.interval === "1d" || pane.interval === "1w" || !pane.candles.length) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ts = pane.chart.timeScale();
      const c = pane.candles;
      const vr = ts.getVisibleLogicalRange();
      if (!vr) return;
      const from = Math.max(1, Math.floor(vr.from)), to = Math.min(c.length - 1, Math.ceil(vr.to));
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio, vpr = scope.verticalPixelRatio;
      const bs = (ts.options().barSpacing || 6) * hpr;
      const dark = true;
      ctx.save();

      // 1) separadores verticales al cambiar de día
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1 * hpr;
      ctx.setLineDash([]);
      for (let i = from; i <= to; i++) {
        if (dayKeyOf(c[i].time) === dayKeyOf(c[i - 1].time)) continue;
        const x = ts.timeToCoordinate(c[i].time);
        if (x == null) continue;
        const px = Math.round(x * hpr - bs / 2) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, scope.bitmapSize.height); ctx.stroke();
      }

      // 2) cierre anterior: línea punteada solo desde la primera vela del último día
      if (pane.prevClose) {
        const lastDay = dayKeyOf(c[c.length - 1].time);
        let firstIdx = c.length - 1;
        while (firstIdx > 0 && dayKeyOf(c[firstIdx - 1].time) === lastDay) firstIdx--;
        const x0 = ts.timeToCoordinate(c[firstIdx].time);
        const y = pane.candleSeries.priceToCoordinate(pane.prevClose);
        if (x0 != null && y != null) {
          const px0 = x0 * hpr - bs / 2, py = Math.round(y * vpr) + 0.5;
          ctx.strokeStyle = dark ? "#e6e6e6" : "#333333";
          ctx.lineWidth = 1 * hpr;
          ctx.setLineDash([8 * hpr, 6 * hpr]);
          ctx.beginPath(); ctx.moveTo(px0, py); ctx.lineTo(scope.bitmapSize.width, py); ctx.stroke();
        }
      }
      ctx.restore();
    });
  }
}

async function loadTargetPrice(pane) {
  try {
    pane.targetPrice = await api(`/api/target-price/${pane.symbol}`);
  } catch (_) {
    pane.targetPrice = null;
  }
  applyTargetPriceLine(pane);
}

function applyTargetPriceLine(pane) {
  if (pane.targetPriceLine) {
    try { pane.candleSeries.removePriceLine(pane.targetPriceLine); } catch (_) {}
    pane.targetPriceLine = null;
  }
  if (pane.targetPrice && pane.targetPrice.average) {
    pane.targetPriceLine = pane.candleSeries.createPriceLine({
      price: pane.targetPrice.average, color: "#facc15", lineWidth: 2,
      lineStyle: LC.LineStyle.Solid, axisLabelVisible: true,
      title: `Target $${pane.targetPrice.average.toFixed(2)}`,
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
  renderFavSelect();
  aplicarFiltroWl(); // el filtro sobrevive a los repintados
}

// ---- filtro de la lista de seguimiento ----
// Actúa sobre lo ya pintado, así vale para las tres pestañas sin duplicar lógica.

function aplicarFiltroWl() {
  const input = document.getElementById("wlFilter");
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  document.getElementById("wlFilterClear").classList.toggle("hidden", !q);

  document.querySelectorAll("#sidebar-left .wl-symbol").forEach((el) => {
    const ticker = (el.dataset.ticker || "").toLowerCase();
    const nombre = (el.querySelector(".wls-name")?.textContent || "").toLowerCase();
    el.classList.toggle("filtrado", !!q && !ticker.includes(q) && !nombre.includes(q));
  });

  // Un grupo sin coincidencias se oculta entero; con filtro activo se despliega
  // para que el resultado se vea aunque estuviera plegado.
  document.querySelectorAll("#watchlistTree .wl-group").forEach((g) => {
    const visibles = g.querySelectorAll(".wl-symbol:not(.filtrado)").length;
    g.classList.toggle("filtrado", !!q && !visibles);
    if (q && visibles) g.classList.remove("collapsed");
  });
}

const wlFilterInput = document.getElementById("wlFilter");
if (wlFilterInput) {
  wlFilterInput.addEventListener("input", aplicarFiltroWl);
  wlFilterInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { wlFilterInput.value = ""; aplicarFiltroWl(); }
    // Enter carga el primer resultado, para no tener que soltar el teclado
    if (e.key === "Enter") {
      const primero = document.querySelector("#sidebar-left .wl-symbol:not(.filtrado)");
      if (primero) selectSymbol(primero.dataset.ticker);
    }
  });
  document.getElementById("wlFilterClear").addEventListener("click", () => {
    wlFilterInput.value = "";
    aplicarFiltroWl();
    wlFilterInput.focus();
  });
}

// Selector rápido de favoritos en la barra superior: evita abrir la lista lateral.
function renderFavSelect() {
  const sel = document.getElementById("favSelect");
  if (!sel) return;
  const favs = getLocalFavs();
  const names = {};
  (state.watchlistGroups || []).forEach((g) => g.symbols.forEach((s) => { names[s.ticker] = s.name || ""; }));
  // Se mantiene el orden por earnings, igual que en la pestaña Favoritos.
  const rows = [];
  (state.watchlistGroups || []).forEach((g) => g.symbols.forEach((s) => {
    if (favs.includes(s.ticker) && !rows.some((r) => r.ticker === s.ticker)) rows.push(s);
  }));
  const ordered = sortByEarnings(rows);
  sel.innerHTML = `<option value="">★ Favoritos${ordered.length ? "" : " (ninguno)"}</option>` +
    ordered.map((s) => `<option value="${s.ticker}">${s.ticker}${s.name ? " — " + escapeHtml(s.name) : ""}</option>`).join("");
  sel.value = "";
}

document.getElementById("favSelect").addEventListener("change", (e) => {
  const t = e.target.value;
  if (t) selectSymbol(t);
  e.target.value = "";
});

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
// Los que reportan pronto se anclan arriba, ordenados por fecha; el resto conserva
// el orden guardado, que es el que el usuario fija arrastrando.
function sortByEarnings(symbols) {
  const conFecha = symbols.filter((s) => state.nextEarningsMap[s.ticker]?.date);
  const resto = symbols.filter((s) => !state.nextEarningsMap[s.ticker]?.date);
  conFecha.sort((a, b) => {
    const da = state.nextEarningsMap[a.ticker].date, db = state.nextEarningsMap[b.ticker].date;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return [...conFecha, ...resto];
}

/** ¿Está anclado arriba por earnings? Esos no se reordenan a mano. */
function anclado(ticker) { return !!state.nextEarningsMap[ticker]?.date; }

function renderGroup(g) {
  const div = document.createElement("div");
  div.className = "wl-group";
  div.innerHTML = `
    <div class="wl-group-header">
      <span class="caret"><i class="fa-solid fa-chevron-down"></i></span>
      <span class="wl-group-name" title="Doble clic para renombrar">${escapeHtml(g.name)}</span>
      <button class="wl-group-edit" title="Renombrar grupo"><i class="fa-solid fa-pen"></i></button>
      <button class="wl-group-move" data-dir="up" title="Subir grupo"><i class="fa-solid fa-chevron-up"></i></button>
      <button class="wl-group-move" data-dir="down" title="Bajar grupo"><i class="fa-solid fa-chevron-down"></i></button>
      <button class="wl-group-del" title="Eliminar grupo"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wl-symbols" data-group-id="${g.id}"></div>`;

  div.querySelector(".wl-group-header").addEventListener("click", (e) => {
    if (e.target.closest(".wl-group-del") || e.target.closest(".wl-group-move")
        || e.target.closest(".wl-group-edit")) return;
    div.classList.toggle("collapsed");
  });
  // Sube/baja el grupo completo (con todos sus símbolos) un puesto.
  div.querySelectorAll(".wl-group-move").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await api(`/api/watchlist/groups/${g.id}/move`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: btn.dataset.dir }),
    });
    loadWatchlist();
  }));
  const renombrar = async (e) => {
    e.stopPropagation();
    const name = prompt("Nuevo nombre del grupo:", g.name);
    if (!name || name.trim() === g.name) return;
    await api(`/api/watchlist/groups/${g.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    loadWatchlist();
  };
  div.querySelector(".wl-group-name").addEventListener("dblclick", renombrar);
  div.querySelector(".wl-group-edit").addEventListener("click", renombrar);
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
    if (!sid) return;
    // Se suelta delante del símbolo bajo el cursor; si cae en el hueco final, va al fondo.
    const sobre = e.target.closest(".wl-symbol");
    const before = sobre && sobre.dataset.symbolId !== sid ? Number(sobre.dataset.symbolId) : null;
    await api(`/api/watchlist/symbols/${sid}/move`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: g.id, before_id: before }),
    });
    loadWatchlist();
  });

  const showPremarket = /etf|materia/i.test(g.name);
  sortByEarnings(g.symbols).forEach((s) => symsEl.appendChild(renderSymbol(s, showPremarket)));
  return div;
}

function renderSymbol(s, showPremarket) {
  const el = document.createElement("div");
  el.className = "wl-symbol" + (s.ticker === state.symbol ? " active" : "")
    + (anclado(s.ticker) ? " anclado" : "");
  el.dataset.ticker = s.ticker;
  el.dataset.symbolId = s.id;
  // los anclados por earnings mantienen su sitio: se arrastran solo entre grupos
  el.draggable = true;
  const next = state.nextEarningsMap[s.ticker];
  const statusLabel = next ? (STATUS_LABELS[next.status] || next.status) : "";
  const timeLabel = next && next.time_of_day ? TIME_LABELS[next.time_of_day] : "";
  const timeShort = next && next.time_of_day ? ` ${TIME_SHORT[next.time_of_day]}` : "";
  // Un earnings ya ocurrido (hasta 2 días atrás) se muestra con check verde: explica
  // los movimientos recientes del activo y desaparece solo pasados esos 2 días.
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const isPastEarnings = next && next.date < todayET;
  const badge = next
    ? (isPastEarnings
      ? `<span class="wls-earnings past" title="Reportó el ${fechaCorta(next.date)}${timeLabel ? " — " + timeLabel : ""}"><i class="fa-solid fa-circle-check"></i> ${formatShortDate(next.date)}${timeShort}</span>`
      : `<span class="wls-earnings ${next.status}" title="Próximo reporte: ${fechaCorta(next.date)}${timeLabel ? " — " + timeLabel : ""} (${statusLabel})"><i class="fa-solid fa-calendar-days"></i> ${formatShortDate(next.date)}${timeShort}</span>`)
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
  // Grupo donde ya vive cada ticker, para marcarlo y no ofrecerlo como nuevo.
  const enLista = {};
  (state.watchlistGroups || []).forEach((g) =>
    g.symbols.forEach((s) => { enLista[s.ticker] = g.name; }));

  searchResults.innerHTML = results.map((r) => {
    const grupo = enLista[r.ticker];
    return `<div class="sr-item${grupo ? " ya-esta" : ""}" data-ticker="${r.ticker}" data-name="${escapeHtml(r.name)}">
      <div class="sr-ticker">${r.ticker} <small>${r.exchange || ""}</small>${
        grupo ? `<span class="sr-en-lista"><i class="fa-solid fa-check"></i> ${escapeHtml(grupo)}</span>` : ""}</div>
      <div class="sr-name">${escapeHtml(r.name)}</div>
    </div>`;
  }).join("");
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
        // Va al grupo del activo que se está viendo, para que buscar desde dentro de
        // una carpeta lo añada ahí y no siempre en la primera.
        const actual = groups.find((g) => g.symbols.some((s) => s.ticker === state.symbol));
        groupId = (actual || groups[0]).id;
      }
      const r = await api("/api/watchlist/symbols", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, name, group_id: groupId }),
      });
      // el backend no duplica: si ya estaba, avisa en qué grupo vive
      if (r.duplicado) toast(`${ticker} ya está en el grupo "${r.duplicado}".`);
      await loadWatchlist();
      searchResults.classList.add("hidden");
      searchInput.value = "";
      selectSymbol(ticker);
    });
  });
}

// ---------------- MA config ----------------

async function loadMAConfig(pane) {
  const r = await api(`/api/ma-config?symbol=${pane.symbol}`);
  pane.maConfig = r.config;
  renderMAs(pane);
  refreshDma(pane);
}

// ---------------- alarms (solo líneas en el gráfico; el panel de gestión se quitó) ----------------

async function loadAlarms(pane) {
  try {
    pane.alarms = await api(`/api/alarms?symbol=${pane.symbol}`);
  } catch (_) {
    pane.alarms = [];
  }
  applyAlarmPriceLines(pane);
}

function applyAlarmPriceLines(pane) {
  pane.alarmPriceLines.forEach((pl) => { try { pane.candleSeries.removePriceLine(pl); } catch (_) {} });
  pane.alarmPriceLines = [];
  pane.alarms.filter((a) => a.active).forEach((a) => {
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
      Object.values(panes).forEach((p) => { if (p.symbol === ev.symbol) loadAlarms(p); });
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
async function loadEarnings(pane) {
  try {
    const result = await api(`/api/earnings/${pane.symbol}`);
    pane.earnings = result.earnings;
  } catch (_) {
    pane.earnings = [];
  }
  updateEarningsMarkers(pane);
}

function updateEarningsMarkers(pane) {
  if (pane.interval !== "1d" || !pane.earnings.length) {
    pane.earningsMarkersPrimitive.setMarkers([]);
    return;
  }
  const candleTimes = new Set(pane.candles.map((c) => c.time));
  const markers = pane.earnings
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
  const fp = panes[state.activePane];
  const canvas = fp.chart.takeScreenshot();
  const dataUrl = canvas.toDataURL("image/png");
  try {
    await api("/api/snapshot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: fp.symbol, interval: fp.interval, image: dataUrl }),
    });
    toast("Captura guardada en la carpeta capturas/.");
  } catch (e) { toast("Error al guardar captura: " + e.message); }
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `${fp.symbol}_${fp.interval}.png`;
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

// ---------------- panel de rango de precios (cadena de opciones) ----------------
// Método: para cada contrato del vencimiento más cercano, RANGO = strike + prima
// (call) o strike - prima (put), y el % que ese rango representa frente al precio
// actual. Cada cálculo se guarda con todos los datos usados para poder auditarlo.

const appEl = document.getElementById("app");

// ---------------- escáner de toques a la MA20 y cruces de medias ----------------
// Un toque cuenta cuando el precio alcanza la MA20 (sin cerrar al otro lado) y una
// vela posterior rompe el extremo de la vela del toque. Es "excelente" si las medias
// están ordenadas 20>40>100>200 (o al revés en bajista), y "bueno" si es 20>40>200.

// Mapa del mercado (Finviz). Su cabecera manda X-Frame-Options: SAMEORIGIN, así que
// no puede incrustarse en el panel; se abre en otra pestaña, que además deja el mapa
// a pantalla completa y los gráficos intactos al volver.
// ---------------- avisos de inicio y próxima reunión de la Fed ----------------

/** Barra roja de la barra superior con la próxima decisión de tipos del FOMC. */
async function cargarFed() {
  const box = document.getElementById("fedBox");
  try {
    const r = await api("/api/fomc");
    if (!r || !r.date) return;
    const f = new Date(r.date + "T12:00:00");
    const txt = f.toLocaleDateString("es-MX", { day: "numeric", month: "long" });
    const cuando = r.dias === 0 ? "hoy" : r.dias === 1 ? "mañana" : `en ${r.dias} días`;
    box.innerHTML = `<i class="fa-solid fa-landmark"></i> <b>FED</b> ${txt} · ${cuando}`;
    box.title = `Próxima decisión de tipos del FOMC: ${fechaCorta(r.date)}`;
    // se enciende cuando la reunión está encima
    box.classList.toggle("inminente", r.dias <= 3);
    box.classList.remove("hidden");
  } catch (_) { /* sin conexión: la barra simplemente no aparece */ }
}

/** La franja lateral se muestra mientras quede algún panel abierto, y los
    gráficos se reajustan al espacio que queda. */
function sincronizarDock() {
  const abiertos = document.querySelectorAll("#sideDock > aside:not(.hidden)").length;
  appEl.classList.toggle("with-side", abiertos > 0);
  requestAnimationFrame(() =>
    Object.values(panes).forEach((p) => { if (p.candles.length) focusLatest(p); }));
}

/** Panel lateral con el historial completo de cambios de precio objetivo. */
const targetsPanel = document.getElementById("sidebar-targets");

function abrirTargets() {
  targetsPanel.classList.remove("hidden");
  document.getElementById("btnTargets").classList.add("active");
  sincronizarDock();
  cargarHistorialTargets();
}

function cerrarTargets() {
  targetsPanel.classList.add("hidden");
  document.getElementById("btnTargets").classList.remove("active");
  sincronizarDock();
}

async function cargarHistorialTargets() {
  const list = document.getElementById("targetsList");
  const st = document.getElementById("targetsStatus");
  st.textContent = "Cargando…";
  try {
    const r = await api("/api/target-log");
    const filas = r.items || [];
    if (!filas.length) {
      st.textContent = "Sin cambios registrados todavía.";
      list.innerHTML = `<p class="hint" style="padding:0 12px;">Los cambios se registran a medida que los analistas revisan sus objetivos.</p>`;
      return;
    }
    st.textContent = `${filas.length} cambio(s) registrados`;
    list.innerHTML = filas.map((t) => {
      const sube = t.anterior != null && t.valor > t.anterior;
      const pct = t.anterior ? ((t.valor / t.anterior - 1) * 100).toFixed(1) : null;
      return `<div class="tg-row" data-ticker="${t.symbol}" data-ts="${t.ts || 0}">
          <div class="tg-top">
            <b>${t.symbol}</b>
            <span class="tg-delta ${sube ? "up" : "down"}">
              $${t.anterior.toFixed(2)} <i class="fa-solid fa-arrow-right"></i> $${t.valor.toFixed(2)}
            </span>
            <span class="tg-pct ${sube ? "up" : "down"}">${sube ? "+" : ""}${pct}%</span>
            <button class="tg-del" title="Borrar del historial"><i class="fa-solid fa-trash"></i></button>
          </div>
          <div class="tg-sub">detectado ${fechaCorta(t.fecha)}${
            t.updated ? ` · analistas ${fechaCorta(t.updated)}` : ""}</div>
        </div>`;
    }).join("");
    list.querySelectorAll(".tg-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".tg-del")) return;
        selectSymbol(row.dataset.ticker);
      });
      row.querySelector(".tg-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await api(`/api/target-log/${row.dataset.ts}?symbol=${row.dataset.ticker}`,
                    { method: "DELETE" });
          cargarHistorialTargets();
        } catch (err) { toast("No se pudo borrar: " + err.message); }
      });
    });
  } catch (e) {
    st.textContent = "Error al cargar: " + e.message;
  }
}

document.getElementById("btnTargets").addEventListener("click", () =>
  targetsPanel.classList.contains("hidden") ? abrirTargets() : cerrarTargets());
document.getElementById("btnCloseTargets").addEventListener("click", cerrarTargets);
document.getElementById("btnReloadTargets").addEventListener("click", cargarHistorialTargets);

/** Modal de bienvenida con los precios objetivo que cambiaron hace poco. */
async function mostrarAvisos() {
  try {
    const r = await api("/api/avisos");
    const filas = r.targets || [];
    if (!filas.length) return;
    // una vez al día basta: no reaparece al recargar la página
    const hoy = new Date().toLocaleDateString("en-CA");
    if (localStorage.getItem("avisosVistos") === hoy) return;

    document.getElementById("avisosBody").innerHTML = filas.map((t) => {
      const sube = t.anterior != null && t.valor > t.anterior;
      const flecha = t.anterior == null ? "" :
        `<span class="aviso-delta ${sube ? "up" : "down"}">
           $${t.anterior.toFixed(2)} <i class="fa-solid fa-arrow-right"></i> $${t.valor.toFixed(2)}</span>`;
      return `<div class="aviso-row" data-ticker="${t.symbol}">
          <b>${t.symbol}</b> ${flecha}
          <span class="aviso-fecha">${fechaCorta(t.fecha)}</span>
        </div>`;
    }).join("");

    const modal = document.getElementById("avisosModal");
    modal.classList.remove("hidden");
    modal.querySelectorAll(".aviso-row").forEach((row) =>
      row.addEventListener("click", () => {
        selectSymbol(row.dataset.ticker);
        modal.classList.add("hidden");
      }));
    document.getElementById("btnCloseAvisos").addEventListener("click", () => {
      modal.classList.add("hidden");
      localStorage.setItem("avisosVistos", hoy);
    });
  } catch (_) { /* los avisos no son críticos */ }
}

const FINVIZ_MAPA = "https://finviz.com/map";
const btnMapa = document.getElementById("btnMapa");
const mapaMenu = document.getElementById("mapaMenu");

btnMapa.addEventListener("click", (e) => {
  e.stopPropagation();
  mapaMenu.classList.toggle("hidden");
});

mapaMenu.querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    mapaMenu.classList.add("hidden");
    // se reutiliza siempre la misma pestaña, para no acumularlas
    window.open(FINVIZ_MAPA + b.dataset.map, "finvizMapa");
  });
});

document.addEventListener("click", (e) => {
  if (!mapaMenu.classList.contains("hidden") && !e.target.closest(".mapa-wrap")) {
    mapaMenu.classList.add("hidden");
  }
});

const toquesPanel = document.getElementById("sidebar-toques");

function abrirToques() {
  toquesPanel.classList.remove("hidden");
  document.getElementById("btnToques").classList.add("active");
  sincronizarDock();
  if (!document.getElementById("toquesList").innerHTML) escanearToques();
}

function cerrarToques() {
  toquesPanel.classList.add("hidden");
  document.getElementById("btnToques").classList.remove("active");
  sincronizarDock();
}

const TOQ_TFS = ["M15", "1H", "D1"];

function renderToques(items) {
  const list = document.getElementById("toquesList");
  if (!items.length) { list.innerHTML = `<p class="hint" style="padding:0 12px;">Sin datos todavía.</p>`; return; }

  const cabecera = `<div class="toq-grid-head"><span></span>${
    TOQ_TFS.map((tf) => `<span>${tf}</span>`).join("")}</div>`;

  list.innerHTML = cabecera + items.map((it) => {
    const celdas = TOQ_TFS.map((tf) => {
      const c = (it.celdas || {})[tf] || {};
      const r = c.reciente;
      const est = c.estado || "nd";
      if (!r) {
        const tip = c.estado ? `${tf}: ${est === "up" ? "alcista" : est === "down" ? "bajista" : "sin alineación"} · sin rebotes`
                             : `${tf}: sin datos suficientes`;
        return `<span class="toq-cell ${est}" title="${tip}">·</span>`;
      }
      // lo esencial de un vistazo: en qué media rebotó y hace cuántas velas
      const desglose = Object.entries(c.por_media || {})
        .map(([m, n]) => `MA${m}: ${n}`).join(" · ");
      const tip = `${tf} — rebote ${r.direccion} en la MA${r.media}, hace ${r.velas_atras} vela(s)`
        + ` · impulso ${r.impulso_pct}% · ${r.calidad}`
        + (desglose ? ` · total ${c.toques} (${desglose})` : "");
      return `<span class="toq-cell ${est} ${r.calidad}" title="${tip}">
          <b>MA${r.media}</b><i>${r.velas_atras === 0 ? "ahora" : r.velas_atras}</i>
        </span>`;
    }).join("");

    const cruces = (it.cruces || []).map((c) =>
      `<span class="toq-cruce ${c.direccion === "alcista" ? "up" : "down"}">${c.tf} ${c.par}${c.velas_atras <= 3 ? " ●" : ""}</span>`).join("");

    return `
      <div class="toq-row${it.pleno ? " pleno" : ""}" data-ticker="${it.symbol}">
        <div class="toq-grid">
          <span class="toq-sym">${it.symbol}${it.pleno ? '<i class="fa-solid fa-star" title="alineada en las 3 temporalidades"></i>' : ""}</span>
          ${celdas}
        </div>
        ${cruces ? `<div class="toq-cruces">${cruces}</div>` : ""}
      </div>`;
  }).join("");

  list.querySelectorAll(".toq-row").forEach((r) =>
    r.addEventListener("click", () => selectSymbol(r.dataset.ticker)));
}

async function escanearToques() {
  const btn = document.getElementById("btnScanToques");
  const st = document.getElementById("toquesStatus");
  btn.disabled = true;
  btn.classList.add("scanning");
  st.textContent = "Escaneando toda la lista de seguimiento…";
  try {
    const r = await api("/api/toques");
    renderToques(r.items || []);
    // cuántos han rebotado en las últimas velas: es lo que se mira al abrir
    const frescos = (r.items || []).filter((i) =>
      Object.values(i.celdas || {}).some((c) => c.reciente && c.reciente.velas_atras <= 3)).length;
    st.textContent = `${(r.items || []).length} activos · ${frescos} con rebote reciente · ${r.status?.updated_at || ""}`;
  } catch (e) {
    st.textContent = "Error al escanear: " + e.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove("scanning");
  }
}

document.getElementById("btnToques").addEventListener("click", () => {
  if (toquesPanel.classList.contains("hidden")) abrirToques(); else cerrarToques();
});
document.getElementById("btnCloseToques").addEventListener("click", cerrarToques);
document.getElementById("btnScanToques").addEventListener("click", escanearToques);

const rangosPanel = document.getElementById("sidebar-rangos");
let rangoKind = "call";

function openRangosPanel() {
  rangosPanel.classList.remove("hidden");
  if (localStorage.getItem("rangosWide") === "1") {
    appEl.classList.add("rangos-wide");
    const i = document.querySelector("#btnExpandRangos i");
    if (i) i.className = "fa-solid fa-down-left-and-up-right-to-center";
  }
  document.getElementById("btnRangos").classList.add("active");
  sincronizarDock();
  fillRangoSymbols();
  loadRangoCfg();
  loadRangosHist();
}

function closeRangosPanel() {
  rangosPanel.classList.add("hidden");
  appEl.classList.remove("rangos-wide");
  document.getElementById("btnRangos").classList.remove("active");
  sincronizarDock();
}

// El desplegable se llena con la watchlist; se preselecciona el símbolo del panel enfocado.
function fillRangoSymbols() {
  const sel = document.getElementById("rangoSymbol");
  const current = sel.value || panes[state.activePane].symbol;
  const seen = new Set();
  sel.innerHTML = "";
  (state.watchlistGroups || []).forEach((g) => g.symbols.forEach((s) => {
    if (seen.has(s.ticker)) return;
    seen.add(s.ticker);
    const o = document.createElement("option");
    o.value = s.ticker;
    o.textContent = `${s.ticker} — ${s.name || ""}`.trim();
    sel.appendChild(o);
  }));
  if (seen.has(current)) sel.value = current;
}

function renderTiming(t) {
  const el = document.getElementById("rangoTiming");
  if (!t) { el.innerHTML = ""; return; }
  const icon = t.quality === "bueno" ? "fa-circle-check" : t.quality === "regular" ? "fa-triangle-exclamation" : "fa-circle-xmark";
  el.className = `rango-timing ${t.quality}`;
  el.innerHTML = `
    <div class="rt-top"><i class="fa-solid ${icon}"></i> ${t.message}</div>
    <div class="rt-sub">Franja ideal: <b>${t.best_window_cdmx}</b> hora CDMX (${t.best_window_et} NY) · ahora ${t.now_cdmx} CDMX</div>`;
}

// La tarjeta muestra SOLO el rango óptimo (mínimo y máximo). El detalle con todos
// los precios usados aparece al hacer clic en ella.
function renderRangoResult(c) {
  const el = document.getElementById("rangoResult");
  if (!c) { el.innerHTML = ""; return; }
  const dirCls = c.direction === "alcista" ? "up" : c.direction === "bajista" ? "down" : "";
  // Las dos filas de mayor porcentaje van sombreadas, como en la hoja del video.
  const rows = c.rows.map((r) => `
    <tr class="${r.best ? "best" : ""}">
      <td>${r.strike.toFixed(2)}</td>
      <td>${r.cost.toFixed(0)}</td>
      <td class="strong">${r.day_low != null ? r.day_low.toFixed(0) + " – " + r.day_high.toFixed(0) : "—"}</td>
      <td class="${r.day_pct != null ? "up" : "dim"}">${r.day_pct != null ? r.day_pct.toFixed(1) : "—"}</td>
    </tr>`).join("");

  el.innerHTML = `
    <div class="rango-card" title="Clic para ver los precios usados">
      <div class="rc-top">
        <b class="rc-sym">${c.symbol}</b>
        <span class="rh-kind ${c.kind}">${c.kind.toUpperCase()}</span>
        <span class="rc-dir ${dirCls}">${c.direction}</span>
        <i class="fa-solid fa-chevron-down rc-caret"></i>
      </div>
      <div class="rc-label">Rango óptimo · precio del contrato</div>
      <div class="rc-range"><span>$${c.range_min.toFixed(2)}</span><i class="fa-solid fa-arrow-right-long"></i><span>$${c.range_max.toFixed(2)}</span></div>
      <div class="rc-sub">${c.symbol} a $${c.spot.toFixed(2)} · vence ${c.expiration}</div>
    </div>
    <div class="rango-detail hidden">
      <div class="rango-meta">
        <div>Precio actual <b>$${c.spot.toFixed(2)}</b>
          <span class="${dirCls}">${c.change_pct != null ? (c.change_pct >= 0 ? "+" : "") + c.change_pct.toFixed(2) + "%" : ""}</span>
          · día <b class="${dirCls}">${c.direction}</b></div>
        <div class="dim">${c.rows.length} contratos entre $${Number(c.min_price).toFixed(0)} y $${Number(c.max_price).toFixed(0)} · ${c.eligible} OTM elegibles de ${c.available}</div>
        <div class="dim">Calculado ${c.calculated_at_cdmx} CDMX (${c.calculated_at_et} NY)</div>
      </div>
      <table class="rango-table">
        <thead><tr><th>STRIKE</th><th>PRECIO</th><th>RANGO</th><th>PORCENTAJES</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const card = el.querySelector(".rango-card");
  const detail = el.querySelector(".rango-detail");
  card.addEventListener("click", () => {
    detail.classList.toggle("hidden");
    card.classList.toggle("open", !detail.classList.contains("hidden"));
  });
}

// ---- ajustes del cálculo (precio mínimo y cantidad de datos) ----

let rangoCfg = { min_price: 20, max_price: 600, count: 8 };

async function loadRangoCfg() {
  try {
    rangoCfg = await api("/api/rangos/config");
    document.getElementById("cfgMinPrice").value = rangoCfg.min_price;
    document.getElementById("cfgMaxPrice").value = rangoCfg.max_price;
    document.getElementById("cfgCount").value = rangoCfg.count;
  } catch (_) {}
}

document.getElementById("btnRangoCfg").addEventListener("click", () => {
  document.getElementById("rangoCfgBox").classList.toggle("hidden");
});

// Modo ancho: el panel ocupa toda la pantalla y las tarjetas guardadas se
// distribuyen en cuadrícula, para tener muchos activos a la vista.
document.getElementById("btnExpandRangos").addEventListener("click", () => {
  const wide = appEl.classList.toggle("rangos-wide");
  localStorage.setItem("rangosWide", wide ? "1" : "0");
  const i = document.querySelector("#btnExpandRangos i");
  i.className = wide ? "fa-solid fa-down-left-and-up-right-to-center" : "fa-solid fa-up-right-and-down-left-from-center";
  document.getElementById("btnExpandRangos").title = wide ? "Volver al panel lateral" : "Pantalla completa";
  requestAnimationFrame(() => Object.values(panes).forEach((p) => { if (p.candles.length) focusLatest(p); }));
});

document.getElementById("btnSaveRangoCfg").addEventListener("click", async () => {
  const min_price = parseFloat(document.getElementById("cfgMinPrice").value);
  const max_price = parseFloat(document.getElementById("cfgMaxPrice").value);
  const count = parseInt(document.getElementById("cfgCount").value, 10);
  if (!(min_price >= 0) || !(max_price > min_price) || !(count >= 1 && count <= 100)) {
    toast("Revisa los ajustes: 0 ≤ mínimo < máximo y cantidad entre 1 y 100.");
    return;
  }
  try {
    rangoCfg = await api("/api/rangos/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_price, max_price, count }),
    });
    document.getElementById("rangoCfgBox").classList.add("hidden");
    toast(`Ajustes guardados: $${min_price}-$${max_price}, ${count} datos.`);
  } catch (e) {
    toast("Error al guardar ajustes: " + e.message);
  }
});

async function loadRangosHist() {
  const el = document.getElementById("rangosHist");
  try {
    const list = await api("/api/rangos");
    if (!list.length) { el.innerHTML = `<p class="hint">Aún no hay cálculos guardados.</p>`; return; }
    // Cada cálculo guardado es una tarjeta con su rango óptimo a la vista.
    el.innerHTML = list.map((r) => {
      const rmin = r.range_min != null ? `$${r.range_min.toFixed(0)}` : "—";
      const rmax = r.range_max != null ? `$${r.range_max.toFixed(0)}` : "—";
      return `
      <div class="rango-hist-item" data-id="${r.id}">
        <div class="rh-top">
          <b>${r.symbol}</b>
          <span class="rh-kind ${r.kind}">${r.kind.toUpperCase()}</span>
          <span class="rh-dir ${r.direction === "alcista" ? "up" : r.direction === "bajista" ? "down" : ""}">${r.direction}</span>
          <button class="rh-del" data-del="${r.id}" title="Eliminar"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="rh-range">${rmin} <i class="fa-solid fa-arrow-right-long"></i> ${rmax}</div>
        <div class="rh-sub">${r.created_at} · vence ${r.expiration} · spot $${r.spot.toFixed(2)}</div>
      </div>`;
    }).join("");
    el.querySelectorAll(".rango-hist-item").forEach((it) => it.addEventListener("click", async (e) => {
      if (e.target.closest(".rh-del")) return;
      try {
        const full = await api(`/api/rangos/${it.dataset.id}`);
        renderTiming(full.data.timing);
        renderRangoResult(full.data);
      } catch (err) { toast("Error al abrir el cálculo: " + err.message); }
    }));
    el.querySelectorAll(".rh-del").forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/rangos/${b.dataset.del}`, { method: "DELETE" });
      loadRangosHist();
    }));
  } catch (e) {
    el.innerHTML = `<p class="hint">Error al cargar el histórico: ${e.message}</p>`;
  }
}

document.getElementById("btnRangos").addEventListener("click", () => {
  if (rangosPanel.classList.contains("hidden")) openRangosPanel(); else closeRangosPanel();
});
document.getElementById("btnCloseRangos").addEventListener("click", closeRangosPanel);
document.getElementById("btnReloadRangos").addEventListener("click", loadRangosHist);

document.querySelectorAll(".rango-kind-btn").forEach((b) => b.addEventListener("click", () => {
  rangoKind = b.dataset.kind;
  document.querySelectorAll(".rango-kind-btn").forEach((x) => x.classList.toggle("active", x === b));
}));

document.getElementById("btnCalcRango").addEventListener("click", async () => {
  const btn = document.getElementById("btnCalcRango");
  const symbol = document.getElementById("rangoSymbol").value;
  if (!symbol) { toast("Elige un activo."); return; }
  btn.disabled = true;
  btn.textContent = "Calculando...";
  try {
    const c = await api("/api/rangos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, kind: rangoKind }),
    });
    renderTiming(c.timing);
    renderRangoResult(c);
    loadRangosHist();
    toast(`Rango de ${c.symbol} (${c.kind.toUpperCase()}) calculado y guardado.`);
  } catch (e) {
    toast("Error al calcular: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Calcular y guardar";
  }
});

// ---------------- pantalla completa ----------------
// Usa la API Fullscreen del navegador (misma que F11) para dar toda la pantalla a los
// gráficos. El icono alterna expandir/contraer y se reenfocan las velas al cambiar de tamaño.

const btnFullscreen = document.getElementById("btnFullscreen");

function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
    } else {
      const el = document.documentElement;
      await (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen());
    }
  } catch (e) {
    toast("El navegador no permitió la pantalla completa: " + e.message);
  }
}

function refreshFullscreenBtn() {
  if (!btnFullscreen) return;
  const fs = isFullscreen();
  btnFullscreen.classList.toggle("active", fs);
  btnFullscreen.querySelector("i").className = fs ? "fa-solid fa-compress" : "fa-solid fa-expand";
  btnFullscreen.title = fs ? "Salir de pantalla completa (Esc)" : "Pantalla completa (F11 también)";
  requestAnimationFrame(() => Object.values(panes).forEach((p) => { if (p.candles.length) focusLatest(p); }));
}

if (btnFullscreen) {
  btnFullscreen.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", refreshFullscreenBtn);
  document.addEventListener("webkitfullscreenchange", refreshFullscreenBtn);
}

// ---------------- collapsible sidebar ----------------

const leftSidebar = document.getElementById("sidebar-left");
const btnCollapseLeft = document.getElementById("btnCollapseLeft");

const btnToggleSidebar = document.getElementById("btnToggleSidebar");

function setLeftCollapsed(collapsed) {
  leftSidebar.classList.toggle("collapsed", collapsed);
  appEl.classList.toggle("collapse-left", collapsed);
  localStorage.setItem("leftCollapsed", collapsed ? "1" : "0");
  // El botón de la barra superior refleja el estado (resaltado = lista oculta).
  if (btnToggleSidebar) {
    btnToggleSidebar.classList.toggle("active", collapsed);
    btnToggleSidebar.title = collapsed ? "Mostrar la lista de seguimiento" : "Ocultar la lista de seguimiento";
  }
  // Los gráficos cambian de ancho: reenfocar las últimas velas.
  requestAnimationFrame(() => Object.values(panes).forEach((p) => { if (p.candles.length) focusLatest(p); }));
}

btnCollapseLeft.addEventListener("click", () => setLeftCollapsed(!leftSidebar.classList.contains("collapsed")));
if (btnToggleSidebar) btnToggleSidebar.addEventListener("click", () => setLeftCollapsed(!leftSidebar.classList.contains("collapsed")));

setLeftCollapsed(localStorage.getItem("leftCollapsed") === "1");

// ---------------- init ----------------

(async function init() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  await loadWatchlist();
  // Símbolo inicial de cada panel: el último que ese panel mostró, siempre que siga
  // en la watchlist; si no (p. ej. lo eliminaste), el primer símbolo de tu lista.
  const tickers = [];
  (state.watchlistGroups || []).forEach((g) => g.symbols.forEach((s) => tickers.push(s.ticker)));
  const fallback = tickers[0] || "SPY";
  Object.values(panes).forEach((p) => {
    const saved = localStorage.getItem(`paneSymbol:${p.letter}`);
    p.symbol = saved && tickers.includes(saved) ? saved : fallback;
  });
  setActivePane("A");
  applyLayout(); // carga los paneles visibles (los que no tienen velas aún)
  pollAlarmEvents();
  loadTrendScan();
  pollSaltos();
  cargarFed();
  mostrarAvisos();
  liveTick(); // vela en curso en vivo con el mercado abierto
})();

})();
