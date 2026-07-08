// かな直 Playground v2 — 統合エントリ。
import {
  FINGER_ORDER, FIRST_KEYS, SECOND_KEYS, SINGLE_KEYS, KEYMAP, KEY_CODE,
  MAT_SLOTS, classifyPair, buildMoraKeys, defaultLayout, cloneLayout,
} from "./layout.js";
import { computeMetrics, defaultWeights, classifyStream, suggestPlacements } from "./metrics.js";
import { renderDetail } from "./detail.js";
import { initTyping } from "./typing.js";
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
  suggest: null, // 選択かなの配置サジェスト { mora, curSlot, list, bestSet }
  mode: null, // 実行中の最適化モード: null | "sa" | "polish"
  typingKana: null, // タイピング練習で現在打つべきかな(マトリックスを発光)
  iter: 0,
};

let worker = null;
const cellEls = {};   // slotId -> element
const singleEls = {}; // key -> element

// ---- 指標行 / 重み定義 ----
const METRIC_ROWS = [
  { key: "topRatio", label: "上段率", pct: true, wpath: ["w_top"], wl: "w_top", wmax: 5 },
  { key: "indexStretchRate", label: "人差し内側率(G/H)", pct: true, wpath: ["w_index_stretch"], wl: "w_index_stretch", wmax: 5 },
  { key: "indexBottomRate", label: "人差し下段率(V/M)", pct: true, wpath: ["w_index_bottom"], wl: "w_index_bottom", wmax: 5 },
  { key: "effort", label: "指effort", pct: false, wpath: ["w_effort"], wl: "w_effort", wmax: 5 },
  { key: "sfbRate", label: "SFB率(距離重み)", pct: true, wpath: ["w_sfb"], wl: "w_sfb", wmax: 10 },
  { key: "skipRate", label: "同指スキップ(人差し大移動)", pct: true, wpath: ["w_skip"], wl: "w_skip", wmax: 10 },
  { key: "vbounceRate", label: "ロール逸脱", pct: false, wpath: ["w_vbounce"], wl: "w_vbounce", wmax: 5 },
  { key: "flow", label: "flow(連接)", pct: false, wpath: ["w_flow"], wl: "w_flow", wmax: 5 },
  { key: "orderPen", label: "順序ペナルティ", pct: false, wpath: ["w_order"], wl: "w_order", wmax: 5 },
];

// 連接内訳の種別(現状値の表示と、対応する pen_flow 重みスライダーを併設)。
// 方向つきロール状態機械の分類。sfb は別枠(w_sfb)なので重みスライダーは持たない。
const FLOW_TYPES = ["inroll", "outroll", "redirect", "alt", "repeat", "sfb"];

// 例文の flow 分類(常時表示)。例文はモーラ列として固定。
const FLOW_EXAMPLE_TEXT = "ありがとうございます。";
const FLOW_EXAMPLE_MORAS = ["あ", "り", "が", "と", "う", "ご", "ざ", "い", "ま", "す", "。"];
const FLOW_CAT_META = {
  inroll: { label: "内", legend: "内ロール" },
  outroll: { label: "外", legend: "外ロール" },
  redirect: { label: "反", legend: "反転(redirect)" },
  alt: { label: "互", legend: "交互(alt)" },
  repeat: { label: "連", legend: "連打(repeat)" },
  sfb: { label: "S", legend: "SFB" },
};

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
  buildRollMove();
  buildBreakdowns();
  wireToolbar();

  recomputeLocal();
  renderAll();

  // タイピング練習パネル: jap-n.txt を取得して初期化(UI表示を待たせない)。
  fetch("./jap-n.txt")
    .then((r) => r.text())
    .then((txt) => initTyping($("typingPanel"), txt, setTypingTarget))
    .catch(() => {
      const el = $("typingPanel");
      if (el) el.innerHTML = `<div class="tp-note">jap-n.txt を読み込めませんでした。</div>`;
    });
}

// タイピング練習から現在のかなを受け取り、マトリックスの該当セルを発光させる。
function setTypingTarget(kana) {
  state.typingKana = kana || null;
  renderGrid();
  renderSingles();
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
  if (KEYMAP[f].row === "home" && KEYMAP[s].row === "home" && !KEYMAP[f].stretch && !KEYMAP[s].stretch) return "homehome";
  return "";
}

function buildGrid() {
  const grid = $("grid");
  grid.style.gridTemplateColumns = `26px repeat(${SECOND_KEYS.length}, minmax(30px, 1fr))`;
  grid.innerHTML = "";

  // ヘッダ行: 列 = 第1キー
  grid.appendChild(el("div", "ghead", "2\\1"));
  for (const f of SECOND_KEYS) {
    grid.appendChild(el("div", "ghead" + (f === SEP_KEY ? " sep-l" : ""), f));
  }

  // 本体: 行 = 第2キー、列 = 第1キー。単打キー(F/J/K)の列は無効セルとして描画する。
  SECOND_KEYS.forEach((s) => {
    grid.appendChild(
      el("div", "rhead" + (s === SEP_KEY ? " sep-t" : ""), s)
    );
    SECOND_KEYS.forEach((f) => {
      const single = SINGLE_KEYS.includes(f);
      if (single) {
        // 無効セル: 色ルールは適用しつつ斜線ハッチを重ねる。操作は受け付けない。
        const inv = document.createElement("div");
        const color = keyPairColor(f, s);
        inv.className = ("slot invalid " + color + (f === SEP_KEY ? " sep-l" : "")).trim();
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
      if (f === SEP_KEY) cell.classList.add("sep-l");
      if (s === SEP_KEY) cell.classList.add("sep-t");
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
  computeSuggestions();
  renderGrid();
  renderDetailPanel();
}

// 選択した行列かなを各スロットに置いた場合の総コストを試算し、改善する候補を提案。
// 候補スロットの占有かなとはスワップする前提。差分計算で高速評価する。
function computeSuggestions() {
  const sel = state.selected;
  if (state.optimizing || !sel || sel.kind !== "mat" || !sel.mora) {
    state.suggest = null;
    return;
  }
  const mora = sel.mora;
  const curSlot = sel.id;
  const mat = state.layout.mat;
  const moraKeys = buildMoraKeys(state.layout);
  const candidates = [];
  for (const slot of MAT_SLOTS) {
    if (slot === curSlot) continue;
    const occ = mat[slot];
    if (occ === mora) continue;
    candidates.push({ slot, occ });
  }
  const { baseCost, results, tweak } = suggestPlacements(
    state.ngram, state.weights, moraKeys, mora, curSlot, candidates, 6);
  const list = results.map((r) => ({ slot: r.slot, partner: r.occ, delta: r.delta }));
  const bestSet = new Set(list.filter((r) => r.delta < 0).map((r) => r.slot));
  // ΔCost が +0.0005 未満のスロット=「微調整可能(ほぼ無コストで動かせる)」。
  const tweakSet = new Set(tweak);
  state.suggest = { mora, curSlot, base: baseCost, list, bestSet, tweakSet };
}

// ユーザー編集後の共通処理。
function onLayoutEdited() {
  recomputeLocal();
  computeSuggestions();
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
  const box = $("flowBreak");
  box.innerHTML = "";
  FLOW_TYPES.forEach((t) => {
    // sfb は w_sfb 側で減点するため pen_flow スライダーを持たない。
    const paths = t === "sfb" ? [] : [["pen_flow", t]];
    const labels = t === "sfb" ? [] : ["重み"];
    box.appendChild(breakRow("flow", t, paths, labels));
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

// vbounce 用: 逸脱重み roll_move のスライダー(非人差し指は指ごと1つ、人差し指は方向別)。
// 各行に現在の逸脱出現率(スタッツ)も併記する。
function buildRollMove() {
  const box = $("rollMoveBars");
  box.innerHTML = "";
  const addRow = (path, label, dev, max = 5, title = "") => {
    const row = document.createElement("div");
    row.className = "rm-row";
    row.style.gridTemplateColumns = "96px 46px 1fr 34px";
    row.innerHTML = `<span class="bl" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"${title ? ` title="${title}"` : ""}>${label}</span>
      <span class="rm-stat" data-dev="${dev}" title="逸脱の出現率(現状値)">–</span>
      <input type="range" min="0" max="${max}" step="0.05" data-wpath="${path}">
      <span class="wv" data-wv="${path}"></span>`;
    const slider = row.querySelector("input");
    const wpath = path.split(".");
    slider.value = getP(state.weights, wpath);
    slider.addEventListener("input", () => {
      setP(state.weights, wpath, parseFloat(slider.value));
      onWeightsChanged();
    });
    box.appendChild(row);
  };

  FINGER_ORDER.forEach((f) => {
    if (f === "LI" || f === "RI") {
      addRow(`roll_move.${f}_top`, `${f} 上段`, `${f}_top`);
      addRow(`roll_move.${f}_stretch`, `${f} 内側stretch`, `${f}_stretch`);
      addRow(`roll_move.${f}_bottom`, `${f} 下段`, `${f}_bottom`);
    } else {
      addRow(`roll_move.${f}`, `${f} 上段`, f);
    }
  });
  // はさみ(中指上段×人差し下段の同手連続)加算。roll_move とは別枠のペア罰。
  addRow("vb_scissor", "はさみ加算", "scissor", 6, "中指上段×人差し下段の同手連続(はさみ)への加算");
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
  renderFlowExample();
  renderIter();
}

function renderGrid() {
  const moraKeys = buildMoraKeys(state.layout);
  const neighbors = computeNeighbors(moraKeys);
  // タイピング練習の現在かなの行列スロット(2キーのモーラのみ)。
  const tKeys = state.typingKana ? moraKeys[state.typingKana] : null;
  const tSlot = tKeys && tKeys.length === 2 ? tKeys[0] + tKeys[1] : null;
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
    const bothHome = KEYMAP[k0].row === "home" && KEYMAP[k1].row === "home" && !KEYMAP[k0].stretch && !KEYMAP[k1].stretch;
    cell.classList.toggle("sfb", type === "sfb");
    cell.classList.toggle("repeat", type === "repeat");
    cell.classList.toggle("homehome", bothHome && type !== "sfb" && type !== "repeat");
    cell.classList.toggle("selected", isSelected("mat", slot));
    cell.classList.toggle("neighbor", neighbors.has(slot));
    cell.classList.toggle("suggest", !!(state.suggest && state.suggest.bestSet.has(slot)));
    cell.classList.toggle("tweak", !!(state.suggest && state.suggest.tweakSet.has(slot)));
    cell.classList.toggle("typing-target", slot === tSlot);
  }
}

function renderSingles() {
  const moraKeys = buildMoraKeys(state.layout);
  const tKeys = state.typingKana ? moraKeys[state.typingKana] : null;
  const tSingle = tKeys && tKeys.length === 1 ? tKeys[0] : null;
  SINGLE_KEYS.forEach((key) => {
    const s = singleEls[key];
    s.querySelector(".v").textContent = state.layout.single[key] || "";
    s.classList.toggle("selected", isSelected("single", key));
    s.classList.toggle("locked", state.lockSingle);
    s.classList.toggle("typing-target", key === tSingle);
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
  FLOW_TYPES.forEach((t) => {
    const s = document.querySelector(`[data-flow="${t}"]`);
    if (s) s.textContent = fmtPct(m.flowRates[t] || 0);
  });
  // 逸脱スタッツ(現状値)
  if (m.devRates) {
    document.querySelectorAll("[data-dev]").forEach((s) => {
      s.textContent = fmtPct(m.devRates[s.dataset.dev] || 0);
    });
  }
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
  renderDetail($("detail"), mora, state.ngram, moraKeys, state.suggest);
}

// 例文を現在の配置で打鍵したときの連接分類を可視化(実ストリーム)。
function renderFlowExample() {
  const box = $("flowExample");
  if (!box) return;
  const moraKeys = buildMoraKeys(state.layout);
  const { keys, steps } = classifyStream(FLOW_EXAMPLE_MORAS, moraKeys);

  const counts = {};
  for (const s of steps) if (s.cat !== "none") counts[s.cat] = (counts[s.cat] || 0) + 1;

  let html = `<div class="flowex-sentence">${FLOW_EXAMPLE_TEXT}</div><div class="flowex-stream">`;
  keys.forEach((k, i) => {
    const cls = "flowex-key" + (k.key ? "" : " unplaced");
    const keyText = k.key ? k.key.toLowerCase() : "?";
    html += `<span class="${cls}"><span class="fk-key">${keyText}</span><span class="fk-mora">${k.mora}</span></span>`;
    if (i < steps.length) {
      const cat = steps[i].cat;
      const meta = FLOW_CAT_META[cat];
      html += `<span class="flowex-op cat-${cat}" title="${meta ? meta.legend : "未配置"}">${meta ? meta.label : "–"}</span>`;
    }
  });
  html += `</div>`;

  const legend = FLOW_TYPES.map((c) => {
    const meta = FLOW_CAT_META[c];
    return `<span class="lg"><i class="cat-${c}"></i>${meta.legend} ${counts[c] || 0}</span>`;
  }).join("");
  html += `<div class="flowex-legend">${legend}</div>`;

  box.innerHTML = html;
}

function renderIter() {
  const bo = $("btnOptimize");
  const bp = $("btnPolish");
  const mode = state.mode;
  if (state.stopping) {
    $("iterLabel").textContent = `停止中… ${state.iter.toLocaleString()}`;
    bo.textContent = mode === "sa" ? "停止中…" : "最適化を開始";
    bp.textContent = mode === "polish" ? "停止中…" : "整地（polish）";
    bo.classList.toggle("running", mode === "sa");
    bp.classList.toggle("running", mode === "polish");
    bo.disabled = true;
    bp.disabled = true;
  } else if (state.optimizing && mode === "polish") {
    $("iterLabel").textContent = `整地中… ${state.iter.toLocaleString()} スワップ`;
    bp.textContent = "整地を停止";
    bp.classList.add("running");
    bp.disabled = false;
    bo.textContent = "最適化を開始";
    bo.classList.remove("running");
    bo.disabled = true;
  } else if (state.optimizing) {
    $("iterLabel").textContent = `最適化中… ${state.iter.toLocaleString()} 反復`;
    bo.textContent = "最適化を停止";
    bo.classList.add("running");
    bo.disabled = false;
    bp.textContent = "整地（polish）";
    bp.classList.remove("running");
    bp.disabled = true;
  } else {
    $("iterLabel").textContent = state.iter ? `停止（${state.iter.toLocaleString()}）` : "";
    bo.textContent = "最適化を開始";
    bo.classList.remove("running");
    bo.disabled = false;
    bp.textContent = "整地（polish）";
    bp.classList.remove("running");
    bp.disabled = false;
  }
}

// ================= ツールバー・最適化 =================
function wireToolbar() {
  $("btnOptimize").addEventListener("click", toggleOptimize);
  $("btnPolish").addEventListener("click", togglePolish);
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
      const finishedMode = state.mode;
      state.optimizing = false;
      state.stopping = false;
      state.mode = null;
      if (typeof msg.iter === "number") state.iter = msg.iter;
      saveState();
      renderAll();
      // SA を止めたら自動で polish して仕上げる(SA+polish 併用ワークフロー)。
      if (finishedMode === "sa") startPolish();
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
    renderFlowExample();
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
    state.mode = "sa";
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

// 整地(polish): 貪欲局所探索で 2-opt 局所最適まで詰める。SA とは排他。
function togglePolish() {
  if (state.stopping) return;
  if (state.optimizing) {
    if (state.mode === "polish") {
      state.stopping = true;
      if (worker) worker.postMessage({ type: "stop" });
      renderIter();
    }
    return; // SA 実行中は polish ボタンは無効化されているため通常来ない。
  }
  startPolish();
}

// polish を開始する(SA 停止後の自動連鎖からも呼ぶ)。
function startPolish() {
  if (state.optimizing) return;
  state.optimizing = true;
  state.mode = "polish";
  ensureWorker().postMessage({
    type: "polish",
    layout: state.layout,
    ngram: state.ngram,
    weights: state.weights,
    lockSingle: state.lockSingle,
  });
  renderIter();
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
  openDialog("配列をインポート（ファイル選択 または JSONを貼り付け）", "", "読み込む", (txt) => {
    try {
      state.layout = parseLayoutJSON(txt);
      dlg.close();
      onLayoutEdited();
    } catch (err) {
      alert("読み込みに失敗しました: " + err.message);
    }
  }, false);
  renderImportExtra();
}

// ファイル選択でJSONファイルを読み込み、内容をテキストエリアへ反映するUI。
function renderImportExtra() {
  const extra = $("ioExtra");
  extra.innerHTML = "";

  const note = document.createElement("div");
  note.className = "kc-note";
  note.textContent = "JSONファイルを選択すると内容が下のテキスト欄に読み込まれます。「読み込む」で反映します。";
  extra.appendChild(note);

  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $("ioText").value = reader.result; };
    reader.onerror = () => alert("ファイルの読み込みに失敗しました");
    reader.readAsText(f);
  });
  extra.appendChild(file);
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
  // qwer / asdf / uiop / jkl; ＋ 人差し指拡張 G V H M の順(4列)で並べる。
  ["Q", "W", "E", "R", "A", "S", "D", "F", "U", "I", "O", "P", "J", "K", "L", ";",
   "G", "V", "H", "M"].forEach((k) => {
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
