// かな直 Playground v2 — 統合エントリ。
import {
  FINGER_ORDER, FIRST_KEYS, SECOND_KEYS, SINGLE_KEYS, KEYMAP, KEY_CODE,
  MAT_SLOTS, classifyPair, buildMoraKeys, defaultLayout, cloneLayout,
} from "./layout.js";
import { computeMetrics, defaultWeights } from "./metrics.js";
import { renderDetail } from "./detail.js";
import {
  exportLayoutJSON, parseLayoutJSON, saveLocal, loadLocal, downloadText,
} from "./storage.js";
import { exportKarabinerString } from "./karabiner.js";

// ---- 状態 ----
const state = {
  ngram: null,
  layout: defaultLayout(),
  weights: defaultWeights(),
  metrics: null,
  selected: null, // { kind:"mat"|"single", id, mora }
  optimizing: false,
  stopping: false, // 停止要求後、ワーカーが実際に止まるまでの間
  lockSingle: false, // 単打キー(F/J/K)を固定して最適化で動かさない
  keyCodes: { ...KEY_CODE }, // Karabiner出力のFROM側key_code(ベース配列に合わせて変更可)
  iter: 0,
};

let worker = null;
const cellEls = {};   // slotId -> element
const singleEls = {}; // key -> element

// ---- 指標行 / 重み定義 ----
const METRIC_ROWS = [
  { key: "topRatio", label: "上段率", pct: true, wpath: ["w_top"], wl: "w_top", wmax: 5 },
  { key: "bottomRatio", label: "下段率", pct: true, wpath: ["w_bottom"], wl: "w_bottom", wmax: 5 },
  { key: "stretchRatio", label: "内側伸展率", pct: true, wpath: ["w_stretch"], wl: "w_stretch", wmax: 5 },
  { key: "effort", label: "指effort", pct: false, wpath: ["w_effort"], wl: "w_effort", wmax: 5 },
  { key: "sfbRate", label: "SFB率(距離重み)", pct: true, wpath: ["w_sfb"], wl: "w_sfb", wmax: 10 },
  { key: "rollRowRate", label: "段またぎroll", pct: false, wpath: ["w_roll_row"], wl: "w_roll_row", wmax: 5 },
  { key: "flowUni", label: "flow_uni", pct: false, wpath: ["w_flow_uni"], wl: "w_flow_uni", wmax: 5 },
  { key: "flowBi", label: "flow_bi", pct: false, wpath: ["w_flow_bi"], wl: "w_flow_bi", wmax: 5 },
  { key: "orderPen", label: "順序ペナルティ", pct: false, wpath: ["w_order"], wl: "w_order", wmax: 5 },
];

// 連接内訳の種別(現状値の表示と、対応するペナルティ重みスライダーを併設)。
// roll の段またぎは独立項 w_roll_row(段またぎroll)で計上するためここには含めない。
const UNI_TYPES = ["roll", "alt", "repeat", "sfb"];
const BI_TYPES = ["roll", "alt", "repeat", "sfb"];

// ---- ユーティリティ ----
const $ = (id) => document.getElementById(id);
const getP = (o, p) => p.reduce((a, k) => a[k], o);
const setP = (o, p, v) => {
  let a = o;
  for (let i = 0; i < p.length - 1; i++) a = a[p[i]];
  a[p[p.length - 1]] = v;
};
const fmtPct = (v) => (v * 100).toFixed(3) + "%";
const fmtNum = (v) => v.toFixed(4);

// 現在のレイアウト・重み・単打固定・キー割当を localStorage に保存。
function saveState() {
  saveLocal({
    layout: state.layout,
    weights: state.weights,
    lockSingle: state.lockSingle,
    keyCodes: state.keyCodes,
  });
}

// ================= 初期化 =================
init();

async function init() {
  const res = await fetch("./data/ngram_data.json");
  const data = await res.json();
  state.ngram = buildNgram(data);

  const saved = loadLocal();
  if (saved) {
    state.layout = saved.layout;
    if (saved.weights) state.weights = mergeWeights(defaultWeights(), saved.weights);
    state.lockSingle = !!saved.lockSingle;
    if (saved.keyCodes) state.keyCodes = { ...KEY_CODE, ...saved.keyCodes };
  }

  buildGrid();
  buildSingles();
  buildMetricRows();
  buildLoads();
  buildBreakdowns();
  wireToolbar();

  recomputeLocal();
  renderAll();
}

// ngram_data.json → 使いやすい形へ。
function buildNgram(data) {
  const unigram = data.unigram || {};
  const bigramList = [];
  for (const [key, c] of Object.entries(data.bigram || {})) {
    const [m1, m2] = key.split("\t");
    bigramList.push([m1, m2, c]);
  }
  let total = 0;
  for (const v of Object.values(unigram)) total += v;
  const sorted = Object.entries(unigram).sort((a, b) => b[1] - a[1]);
  const rank = new Map();
  sorted.forEach(([m], i) => rank.set(m, i + 1));
  // セル背景の基準: 一番多い「い」の頻度(無ければ最大値)。
  const refFreq = unigram["い"] || (sorted.length ? sorted[0][1] : 1);
  // レアかな: 「ぬ」より低頻度のモーラは灰色表示(v1準拠)。
  const rareThreshold = unigram["ぬ"] || 0;
  const rareSet = new Set(Object.keys(unigram).filter((m) => unigram[m] < rareThreshold));
  return { unigram, bigramList, total, rank, types: sorted.length, refFreq, rareThreshold, rareSet };
}

// あるかなが「ぬ」より低頻度(レア)か。頻度データに無いものもレア扱い。
function isRare(kana) {
  if (!kana) return false;
  const f = state.ngram.unigram[kana] || 0;
  return f < state.ngram.rareThreshold;
}

function mergeWeights(base, over) {
  const out = structuredClone(base);
  for (const k of Object.keys(over)) {
    if (typeof over[k] === "object" && !Array.isArray(over[k]) && out[k]) {
      Object.assign(out[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

// ================= グリッド構築 =================
// 最初の右手キー(左右境界のセパレータ用)。
const SEP_KEY = SECOND_KEYS.find((k) => KEYMAP[k].hand === "R");

// キー組の性質による色クラス(かなに依らない)。
function keyPairColor(f, s) {
  const type = classifyPair(f, s);
  if (type === "sfb") return "sfb";
  if (type === "repeat") return "repeat";
  if (KEYMAP[f].row === "home" && KEYMAP[s].row === "home") return "homehome";
  return "";
}

function buildGrid() {
  const grid = $("grid");
  grid.style.gridTemplateColumns = `26px repeat(${SECOND_KEYS.length}, minmax(30px, 1fr))`;
  grid.innerHTML = "";

  // ヘッダ行
  grid.appendChild(el("div", "ghead", "1\\2"));
  for (const s of SECOND_KEYS) {
    grid.appendChild(el("div", "ghead" + (s === SEP_KEY ? " sep-l" : ""), s));
  }

  // 本体: 16キー全てを行に出し、単打キー(F/J/K)の行は無効セルとして描画する。
  SECOND_KEYS.forEach((f) => {
    const single = SINGLE_KEYS.includes(f);
    grid.appendChild(
      el("div", "rhead" + (single ? " single" : "") + (f === SEP_KEY ? " sep-t" : ""), f)
    );
    SECOND_KEYS.forEach((s) => {
      if (single) {
        // 無効セル: 色ルールは適用しつつ斜線ハッチを重ねる。操作は受け付けない。
        const inv = document.createElement("div");
        const color = keyPairColor(f, s);
        inv.className = ("slot invalid " + color + (s === SEP_KEY ? " sep-l" : "")).trim();
        inv.title = `${f} は単打キーのため第1キーになりません`;
        grid.appendChild(inv);
        return;
      }
      const slot = f + s;
      const cell = document.createElement("div");
      cell.className = "slot";
      cell.dataset.slot = slot;
      cell.draggable = true;
      // 頻度に応じた背景バー(「い」比。テキストより背面)。
      const fill = document.createElement("div");
      fill.className = "freq-fill";
      cell.appendChild(fill);
      const kv = document.createElement("span");
      kv.className = "kv";
      cell.appendChild(kv);
      const seq = document.createElement("span");
      seq.className = "seq";
      seq.textContent = slot.toLowerCase();
      cell.appendChild(seq);
      cell._kv = kv;
      cell._fill = fill;
      // 左右境界
      if (s === SEP_KEY) cell.classList.add("sep-l");
      if (f === SEP_KEY) cell.classList.add("sep-t");
      attachCellEvents(cell, "mat", slot);
      cellEls[slot] = cell;
      grid.appendChild(cell);
    });
  });
}

function buildSingles() {
  const box = $("singles");
  box.innerHTML = "";
  SINGLE_KEYS.forEach((key) => {
    const s = document.createElement("div");
    s.className = "single-slot";
    s.dataset.single = key;
    s.draggable = true;
    s.innerHTML = `<span class="k">${key}（単打）</span><span class="v"></span>`;
    attachCellEvents(s, "single", key);
    singleEls[key] = s;
    box.appendChild(s);
  });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ドラッグ＆ドロップ＋クリック選択。
let dragSrc = null; // { kind, id }
function attachCellEvents(cell, kind, id) {
  cell.addEventListener("dragstart", (e) => {
    dragSrc = { kind, id };
    e.dataTransfer.effectAllowed = "move";
  });
  cell.addEventListener("dragover", (e) => {
    if (dragSrc && dragSrc.kind === kind) {
      e.preventDefault();
      cell.classList.add("dragover");
    }
  });
  cell.addEventListener("dragleave", () => cell.classList.remove("dragover"));
  cell.addEventListener("drop", (e) => {
    e.preventDefault();
    cell.classList.remove("dragover");
    if (dragSrc && dragSrc.kind === kind && dragSrc.id !== id) {
      swap(kind, dragSrc.id, id);
    }
    dragSrc = null;
  });
  cell.addEventListener("dragend", () => {
    cell.classList.remove("dragover");
    dragSrc = null;
  });
  cell.addEventListener("click", () => selectCell(kind, id));
}

function swap(kind, a, b) {
  if (kind === "mat") {
    const t = state.layout.mat[a];
    state.layout.mat[a] = state.layout.mat[b];
    state.layout.mat[b] = t;
  } else {
    const t = state.layout.single[a];
    state.layout.single[a] = state.layout.single[b];
    state.layout.single[b] = t;
  }
  onLayoutEdited();
}

function selectCell(kind, id) {
  const mora = kind === "mat" ? state.layout.mat[id] : state.layout.single[id];
  state.selected = { kind, id, mora };
  renderGrid();
  renderDetailPanel();
}

// ユーザー編集後の共通処理。
function onLayoutEdited() {
  recomputeLocal();
  if (state.optimizing && worker) {
    worker.postMessage({ type: "update", layout: state.layout });
  }
  saveState();
  renderAll();
}

// ================= 指標行・重み構築 =================
// 各行 = [指標名 | 現状値(読み取り専用の解析結果) | 重み(編集可能なスライダー)]。
// 現状値は最適化中に変化する解析結果であり、スライダーが動かすのは「重み」。
function buildMetricRows() {
  const box = $("metricRows");
  box.innerHTML = "";
  METRIC_ROWS.forEach((m) => {
    const row = document.createElement("div");
    row.className = "metric";
    row.innerHTML = `
      <span class="m-label">${m.label}</span>
      <span class="m-val" data-mkey="${m.key}" title="現状の解析結果（読み取り専用）">–</span>
      <span class="m-wlabel">重み ${m.wl}</span>
      <span class="m-wval" data-wv="${m.wpath.join(".")}"></span>
      <input type="range" min="0" max="${m.wmax}" step="0.05" data-wpath="${m.wpath.join(".")}">`;
    const slider = row.querySelector("input");
    slider.value = getP(state.weights, m.wpath);
    slider.addEventListener("input", () => {
      setP(state.weights, m.wpath, parseFloat(slider.value));
      onWeightsChanged();
    });
    box.appendChild(row);
  });
}

function buildBreakdowns() {
  const uni = $("uniBreak");
  uni.innerHTML = "";
  UNI_TYPES.forEach((t) => {
    uni.appendChild(breakRow("uni", t, [["pen_uni", t]], ["重み"]));
  });
  // モーラ間はういん接続とその他接続を別行に分ける(現状値・重みとも独立表示)。
  const bi = $("biBreak");
  bi.innerHTML = "";
  BI_TYPES.forEach((t) => {
    bi.appendChild(breakRow("biUin", t, [["pen_bi_uin", t]], ["重み"], `${t}・ういん`));
  });
  BI_TYPES.forEach((t) => {
    bi.appendChild(breakRow("biOther", t, [["pen_bi_other", t]], ["重み"], `${t}・その他`));
  });
}

// 連接内訳の1行: [種別 | 現状値 | (ラベル+スライダー+重み値)...]。
// labelText を省略すると type をそのまま行ラベルに使う。
function breakRow(kind, type, paths, labels, labelText = type) {
  const row = document.createElement("div");
  const wide = labelText !== type ? " bkw" : ""; // 文脈付きラベル(例 roll・ういん)は幅広に。
  row.className = "bk" + (paths.length > 1 ? " bk2" : "") + wide;
  let html = `<span class="l">${labelText}</span><span class="bv2" data-${kind}="${type}">–</span>`;
  paths.forEach((p, i) => {
    const key = p.join(".");
    html += `<span class="sw">` +
      `<span class="swl">${labels[i]}</span>` +
      `<input type="range" min="0" max="3" step="0.05" data-wpath="${key}">` +
      `<span class="wv" data-wv="${key}"></span></span>`;
  });
  row.innerHTML = html;
  row.querySelectorAll("input").forEach((slider) => {
    const path = slider.dataset.wpath.split(".");
    slider.value = getP(state.weights, path);
    slider.addEventListener("input", () => {
      setP(state.weights, path, parseFloat(slider.value));
      onWeightsChanged();
    });
  });
  return row;
}

function onWeightsChanged() {
  recomputeLocal();
  if (state.optimizing && worker) {
    worker.postMessage({ type: "update", weights: state.weights });
  }
  saveState();
  renderMetrics();
  renderWeightValues();
}

function buildLoads() {
  const box = $("loadBars");
  box.innerHTML = "";
  FINGER_ORDER.forEach((f) => {
    const row = document.createElement("div");
    row.className = "load-row";
    row.innerHTML = `<span class="bl">${f}</span>
      <div class="bar-track"><div class="bar-fill" data-load="${f}"></div></div>
      <span class="bv" data-loadv="${f}">–</span>
      <input type="range" min="0" max="3" step="0.05" data-wpath="finger_effort.${f}">
      <span class="wv" data-wv="finger_effort.${f}"></span>`;
    const slider = row.querySelector("input");
    slider.value = getP(state.weights, ["finger_effort", f]);
    slider.addEventListener("input", () => {
      setP(state.weights, ["finger_effort", f], parseFloat(slider.value));
      onWeightsChanged();
    });
    box.appendChild(row);
  });
}

// ================= 計算 =================
function recomputeLocal() {
  state.metrics = computeMetrics(state.layout, state.ngram, state.weights);
}

// ================= 描画 =================
function renderAll() {
  renderGrid();
  renderSingles();
  renderMetrics();
  renderWeightValues();
  renderDetailPanel();
  renderIter();
}

function renderGrid() {
  const moraKeys = buildMoraKeys(state.layout);
  const neighbors = computeNeighbors(moraKeys);
  for (const slot of MAT_SLOTS) {
    const cell = cellEls[slot];
    const kana = state.layout.mat[slot];
    cell._kv.textContent = kana || "";
    // 頻度バー(「い」比)。
    const freq = kana ? (state.ngram.unigram[kana] || 0) : 0;
    const w = state.ngram.refFreq > 0 ? Math.min(100, freq / state.ngram.refFreq * 100) : 0;
    cell._fill.style.width = w + "%";
    // 色クラス
    cell.classList.toggle("empty", !kana);
    cell.classList.toggle("rare", isRare(kana));
    const [k0, k1] = [slot[0], slot.slice(1)];
    const type = classifyPair(k0, k1);
    const bothHome = KEYMAP[k0].row === "home" && KEYMAP[k1].row === "home";
    cell.classList.toggle("sfb", type === "sfb");
    cell.classList.toggle("repeat", type === "repeat");
    cell.classList.toggle("homehome", bothHome && type !== "sfb" && type !== "repeat");
    cell.classList.toggle("selected", isSelected("mat", slot));
    cell.classList.toggle("neighbor", neighbors.has(slot));
  }
}

function renderSingles() {
  SINGLE_KEYS.forEach((key) => {
    const s = singleEls[key];
    s.querySelector(".v").textContent = state.layout.single[key] || "";
    s.classList.toggle("selected", isSelected("single", key));
    s.classList.toggle("locked", state.lockSingle);
  });
}

function isSelected(kind, id) {
  return state.selected && state.selected.kind === kind && state.selected.id === id;
}

// 選択モーラの前後 top 連接先セルを近傍としてハイライト。
function computeNeighbors(moraKeys) {
  const set = new Set();
  if (!state.selected || !state.selected.mora) return set;
  const mora = state.selected.mora;
  const partners = [];
  for (const [m1, m2, c] of state.ngram.bigramList) {
    if (m1 === mora) partners.push([m2, c]);
    else if (m2 === mora) partners.push([m1, c]);
  }
  partners.sort((a, b) => b[1] - a[1]);
  const slotOf = {};
  for (const slot of MAT_SLOTS) {
    const k = state.layout.mat[slot];
    if (k) slotOf[k] = slot;
  }
  for (const [p] of partners.slice(0, 6)) {
    if (slotOf[p]) set.add(slotOf[p]);
  }
  return set;
}

function renderMetrics() {
  const m = state.metrics;
  if (!m || !m.valid) return;
  $("vCost").textContent = m.cost.toFixed(4);
  $("vEffort").textContent = m.effort.toFixed(4);
  METRIC_ROWS.forEach((row) => {
    const span = document.querySelector(`[data-mkey="${row.key}"]`);
    if (span) span.textContent = row.pct ? fmtPct(m[row.key]) : fmtNum(m[row.key]);
  });
  // loads(指の使用率)
  FINGER_ORDER.forEach((f) => {
    const v = m.loads[f] || 0;
    const fill = document.querySelector(`[data-load="${f}"]`);
    const val = document.querySelector(`[data-loadv="${f}"]`);
    if (fill) fill.style.width = Math.min(100, v * 100 * 3) + "%"; // 0..33%程度を可視化
    if (val) val.textContent = fmtPct(v);
  });
  // 連接内訳(現状値)
  UNI_TYPES.forEach((t) => {
    const s = document.querySelector(`[data-uni="${t}"]`);
    if (s) s.textContent = fmtPct(m.uni[t] || 0);
  });
  BI_TYPES.forEach((t) => {
    const su = document.querySelector(`[data-biUin="${t}"]`);
    if (su) su.textContent = fmtPct(m.biUin[t] || 0);
    const so = document.querySelector(`[data-biOther="${t}"]`);
    if (so) so.textContent = fmtPct(m.biOther[t] || 0);
  });
}

function renderWeightValues() {
  document.querySelectorAll("[data-wv]").forEach((span) => {
    const path = span.dataset.wv.split(".");
    span.textContent = getP(state.weights, path).toFixed(2);
  });
  // スライダー位置も同期(import 等で weights が差し替わった場合)。
  document.querySelectorAll("input[data-wpath]").forEach((sl) => {
    const path = sl.dataset.wpath.split(".");
    sl.value = getP(state.weights, path);
  });
}

function renderDetailPanel() {
  const moraKeys = buildMoraKeys(state.layout);
  const mora = state.selected ? state.selected.mora : null;
  renderDetail($("detail"), mora, state.ngram, moraKeys);
}

function renderIter() {
  const btn = $("btnOptimize");
  if (state.stopping) {
    $("iterLabel").textContent = `停止中… ${state.iter.toLocaleString()} 反復`;
    btn.textContent = "停止中…";
    btn.classList.remove("running");
    btn.disabled = true;
  } else if (state.optimizing) {
    $("iterLabel").textContent = `最適化中… ${state.iter.toLocaleString()} 反復`;
    btn.textContent = "最適化を停止";
    btn.classList.add("running");
    btn.disabled = false;
  } else {
    $("iterLabel").textContent = state.iter ? `停止（${state.iter.toLocaleString()} 反復）` : "";
    btn.textContent = "最適化を開始";
    btn.classList.remove("running");
    btn.disabled = false;
  }
}

// ================= ツールバー・最適化 =================
function wireToolbar() {
  $("btnOptimize").addEventListener("click", toggleOptimize);
  $("btnReset").addEventListener("click", () => {
    state.layout = defaultLayout();
    onLayoutEdited();
  });
  $("btnExport").addEventListener("click", openExport);
  $("btnImport").addEventListener("click", openImport);
  $("btnKarabiner").addEventListener("click", openKarabiner);

  const lockCb = $("lockSingle");
  lockCb.checked = state.lockSingle;
  lockCb.addEventListener("change", () => {
    state.lockSingle = lockCb.checked;
    if (state.optimizing && worker) {
      worker.postMessage({ type: "update", lockSingle: state.lockSingle });
    }
    saveState();
    renderSingles();
  });
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./optimizer.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "progress") {
      state.layout = cloneLayout(msg.layout);
      state.metrics = msg.metrics;
      state.iter = msg.iter;
      scheduleRender();
    } else if (msg.type === "stopped") {
      state.optimizing = false;
      state.stopping = false;
      if (typeof msg.iter === "number") state.iter = msg.iter;
      saveState();
      renderIter();
    }
  };
  return worker;
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderGrid();
    renderSingles();
    renderMetrics();
    renderDetailPanel();
    renderIter();
  });
}

function toggleOptimize() {
  if (state.stopping) return; // 停止完了待ちの間は無視。
  if (state.optimizing) {
    // 停止要求。ワーカーが実際に止まるまでは「停止中…」表示。
    state.stopping = true;
    if (worker) worker.postMessage({ type: "stop" });
    renderIter();
  } else {
    state.optimizing = true;
    ensureWorker().postMessage({
      type: "start",
      layout: state.layout,
      ngram: state.ngram,
      weights: state.weights,
      lockSingle: state.lockSingle,
    });
    renderIter();
  }
}

// ================= import/export ダイアログ =================
const dlg = $("ioDialog");
function openDialog(title, text, actionLabel, onAction, readOnly) {
  $("ioExtra").innerHTML = "";
  $("ioTitle").textContent = title;
  $("ioText").value = text;
  $("ioText").readOnly = !!readOnly;
  const act = $("ioAction");
  act.textContent = actionLabel;
  act.style.display = onAction ? "" : "none";
  act.onclick = () => { if (onAction) onAction($("ioText").value); };
  $("ioCancel").onclick = () => dlg.close();
  dlg.showModal();
}

function openExport() {
  openDialog("配列をエクスポート", exportLayoutJSON(state.layout, state.metrics),
    "ダウンロード", (txt) => { downloadText("kana-choku.json", txt); dlg.close(); }, false);
}

function openImport() {
  openDialog("配列をインポート（JSONを貼り付け）", "", "読み込む", (txt) => {
    try {
      state.layout = parseLayoutJSON(txt);
      dlg.close();
      onLayoutEdited();
    } catch (err) {
      alert("読み込みに失敗しました: " + err.message);
    }
  }, false);
}

function openKarabiner() {
  openDialog("Karabiner complex modifications",
    "",
    "ダウンロード", (txt) => { downloadText("kana-choku-karabiner.json", txt); dlg.close(); }, true);
  renderKarabinerExtra();
}

// ベース配列対応: 16キー(FROM側の物理キー)の key_code を編集するUI。
function renderKarabinerExtra() {
  const extra = $("ioExtra");
  const regen = () => { $("ioText").value = exportKarabinerString(state.layout, state.keyCodes); };
  extra.innerHTML = "";

  const note = document.createElement("div");
  note.className = "kc-note";
  note.textContent = "非QWERTYのベース配列向けに、各キー(FROM側の物理キー)の Karabiner key_code を変更できます。既定はQWERTY。";
  extra.appendChild(note);

  const grid = document.createElement("div");
  grid.className = "kc-grid";
  // qwer / asdf / uiop / jkl; の順(4列)で並べる。
  ["Q", "W", "E", "R", "A", "S", "D", "F", "U", "I", "O", "P", "J", "K", "L", ";"].forEach((k) => {
    const cell = document.createElement("label");
    cell.className = "kc-cell";
    const span = document.createElement("span");
    span.className = "kc-k";
    span.textContent = k;
    const input = document.createElement("input");
    input.type = "text";
    input.size = 1; // 既定幅で膨らまないように(実幅はCSSのflexで決める)
    input.spellcheck = false;
    input.value = state.keyCodes[k];
    input.addEventListener("input", () => {
      state.keyCodes[k] = input.value.trim();
      saveState();
      regen();
    });
    cell.appendChild(span);
    cell.appendChild(input);
    grid.appendChild(cell);
  });
  extra.appendChild(grid);

  const reset = document.createElement("button");
  reset.className = "kc-reset";
  reset.textContent = "QWERTYに戻す";
  reset.onclick = () => { state.keyCodes = { ...KEY_CODE }; saveState(); renderKarabinerExtra(); };
  extra.appendChild(reset);

  regen();
}
