// かな直 Playground v2 — 統合エントリ。
import {
  SECOND_KEYS, KEYMAP, KEY_CODE, SMALL_YOON, SPLIT_KANA, splitMora,
  singleKeysOf, matSlotsOf, classifyPair, buildMoraKeys, defaultLayout, cloneLayout,
} from "./layout.js";
import { computeMetrics, defaultWeights, classifyStream, suggestPlacements, collectWeakPoints } from "./metrics.js";
import { renderDetail } from "./detail.js";
import { initTyping } from "./typing.js";
import { textToMoras } from "./romaji.js";
import {
  exportLayoutJSON, parseLayoutJSON, saveLocal, loadLocal, downloadText,
} from "./storage.js";
import { exportKarabinerString } from "./karabiner.js";

// ---- 状態 ----
const state = {
  ngram: null,
  ngramData: null, // 生の ngram データ(モード切替時の再構築用)
  yoonSplit: false, // 拗音分解モード(しゃ→し+ゃ。ゃゅょを行列に配置)
  yoonStash: {}, // モード切替で外したかなの退避先 { kana: slot }
  layout: defaultLayout(),
  weights: defaultWeights(),
  metrics: null,
  selected: null, // { kind:"mat"|"single", id, mora }
  optimizing: false,
  stopping: false, // 停止要求後、ワーカーが実際に止まるまでの間
  lockSingle: false, // 単打キー(F/J)を固定して最適化で動かさない
  keyCodes: { ...KEY_CODE }, // Karabiner出力のFROM側key_code(ベース配列に合わせて変更可)
  suggest: null, // 選択かなの配置サジェスト { mora, curSlot, list, bestSet }
  mode: null, // 実行中の最適化モード: null | "sa" | "polish"
  typingKana: null, // タイピング練習で現在打つべきかな(マトリックスを発光)
  iter: 0,
};

let worker = null;
let typingPanel = null; // タイピング練習(モード切替時に練習単位を組み直す)
const cellEls = {};   // slotId -> element
const singleEls = {}; // key -> element
const gheadEls = {};  // 列ヘッダ(第1キー)key -> element(単打かなの併記更新用)

// ---- 指標行 / 重み定義 ----
const METRIC_ROWS = [
  { key: "effort", label: "キーeffort", pct: false, wpath: ["w_effort"], wl: "w_effort", wmax: 5 },
  { key: "flow", label: "flow(連接)", pct: false, wpath: ["w_flow"], wl: "w_flow", wmax: 5 },
  { key: "strokes", label: "打鍵数/モーラ", pct: false, wpath: ["w_strokes"], wl: "w_strokes", wmax: 3 },
  { key: "orderPen", label: "順序ペナルティ", pct: false, wpath: ["w_order"], wl: "w_order", wmax: 5 },
];

// 連接内訳の種別(現状値の表示と、対応する pen_flow 重みスライダーを併設)。
// SFSは距離重み付きの加算項なので、通常のbikey/redirect分類とは分けて定義する。
const FLOW_TYPES = ["indexRedirect", "pinkyRedirect", "middleRedirect", "goodRoll", "badRoll", "alt", "repeat", "sfb"];
const FLOW_BREAK_TYPES = [...FLOW_TYPES, "sfs"];

const FLOW_CAT_META = {
  indexRedirect: { label: "人反", legend: "index redirect" },
  pinkyRedirect: { label: "小反", legend: "pinky redirect" },
  middleRedirect: { label: "中反", legend: "middle redirect" },
  goodRoll: { label: "良ロ", legend: "good roll" },
  badRoll: { label: "悪ロ", legend: "bad roll" },
  alt: { label: "互", legend: "交互(alt)" },
  repeat: { label: "連", legend: "連打(repeat)" },
  sfb: { label: "S", legend: "SFB" },
  sfs: { label: "SFS", legend: "SFS" },
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
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

// 現在のレイアウト・重み・単打固定・キー割当・拗音モードを localStorage に保存。
function saveState() {
  saveLocal({
    layout: state.layout,
    weights: state.weights,
    lockSingle: state.lockSingle,
    keyCodes: state.keyCodes,
    yoonSplit: state.yoonSplit,
    yoonStash: state.yoonStash,
  });
}

// ================= 初期化 =================
init();

async function init() {
  const res = await fetch("./data/ngram_data.json");
  state.ngramData = await res.json();

  const saved = loadLocal();
  if (saved) {
    state.layout = saved.layout;
    if (saved.weights) state.weights = mergeWeights(defaultWeights(), migrateWeights(saved.weights));
    state.lockSingle = !!saved.lockSingle;
    if (saved.keyCodes) state.keyCodes = { ...KEY_CODE, ...saved.keyCodes };
    state.yoonSplit = !!saved.yoonSplit;
    if (saved.yoonStash) state.yoonStash = saved.yoonStash;
  }
  rebuildNgram();
  // 分解モードで保存されていた場合、配置の不変条件を復元時にも強制する
  // (旧仕様の保存データに外来語音が残っている場合の自己修復を兼ねる)。
  if (state.yoonSplit) {
    enforceYoonMode();
    saveState();
  }

  ensureStructure();
  buildMetricRows();
  buildLoads();
  buildBreakdowns();
  wireToolbar();

  recomputeLocal();
  renderAll();

  // タイピング練習パネル: jap-n.txt を取得して初期化(UI表示を待たせない)。
  // 練習単位はモードに応じて展開する(分解モードでは しゃ→し+ゃ)。
  fetch("./jap-n.txt")
    .then((r) => r.text())
    .then((txt) => {
      typingPanel = initTyping($("typingPanel"), txt, setTypingTarget,
        (mora) => (state.yoonSplit ? splitMora(mora) : [mora]));
    })
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

// 現在のモードに応じて state.ngram を再構築する。
// 分解モードでは unigram を単位かなの実効頻度へ変換する(し += しゃ/しゅ/しょ 等、
// ゃ = Σ拗音。グリッド頻度バー・レア判定・最適化の重み付き選択に効く)。
// bigramList は変換しない: 拗音のキー列は buildMoraKeys が「基底+小書き」の連結として
// 導出するので、モーラあたり正規化の分母がモード間で不変に保たれる。
function rebuildNgram() {
  const data = state.ngramData;
  if (!state.yoonSplit) {
    state.ngram = buildNgram(data);
    return;
  }
  const unigram = {};
  for (const [m, c] of Object.entries(data.unigram || {})) {
    for (const u of splitMora(m)) unigram[u] = (unigram[u] || 0) + c;
  }
  state.ngram = buildNgram({ unigram, bigram: data.bigram });
}

// suggestPlacements 用: 分解モードでは分解対象モーラを構成単位 [基底, 小書き] に展開する。
function unitsOfMora(m) {
  if (!state.yoonSplit) return null;
  const units = splitMora(m);
  return units.length === 2 ? units : null;
}

// 現在のモードに合わせて配置の不変条件を強制する:
// 分解モードなら分解対象モーラ(拗音・外来語音)を退避して ゃゅょ を配置、一体モードなら逆。
// リセット・インポート・起動時など、レイアウトを外から差し替えた後にも呼ぶ。
function enforceYoonMode() {
  const single = state.layout.single;
  const deactivate = state.yoonSplit ? SPLIT_KANA : SMALL_YOON;
  const activate = state.yoonSplit ? SMALL_YOON : SPLIT_KANA;
  for (const [slot, kana] of Object.entries(state.layout.mat)) {
    if (kana && deactivate.includes(kana)) {
      state.yoonStash[kana] = slot;
      state.layout.mat[slot] = "";
    }
  }
  for (const [key, kana] of Object.entries(single)) {
    if (kana && deactivate.includes(kana)) {
      state.yoonStash[kana] = "";
      delete single[key]; // かなの無い単打は存在しない(解除して列を復活)
    }
  }
  // 単打集合が変わった場合に備えて行列スロット集合を揃える。
  const mat = {};
  for (const slot of getMatSlots()) mat[slot] = state.layout.mat[slot] || "";
  state.layout.mat = mat;

  const placed = new Set([...Object.values(mat), ...Object.values(single)].filter(Boolean));
  const slots = getMatSlots();
  for (const kana of activate) {
    if (placed.has(kana)) continue;
    let slot = state.yoonStash[kana];
    if (!slot || !(slot in mat) || mat[slot]) slot = slots.find((s) => !mat[s]);
    if (slot) {
      mat[slot] = kana;
      placed.add(kana);
    }
  }
}

// 拗音分解モードの切替。
function applyYoonMode(split) {
  state.yoonSplit = split;
  enforceYoonMode();
  rebuildNgram();
  onLayoutEdited();
  if (typingPanel) typingPanel.refresh(); // 練習中の一節を現在のモードの単位に組み直す
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

function migrateWeights(weights) {
  const migrated = structuredClone(weights);
  delete migrated.w_vbounce;
  delete migrated.roll_move;
  if (!migrated.key_effort) {
    const fallbackFinger = {
      LP: 1.8, LR: 1.7, LM: 1.3, LI: 1.0,
      RI: 1.0, RM: 1.0, RR: 1.7, RP: 1.8,
    };
    const fingerEffort = migrated.finger_effort || fallbackFinger;
    const effortScale = migrated.w_effort ?? 1;
    const topWeight = migrated.w_top ?? 1;
    const stretchWeight = migrated.w_index_stretch ?? 0.2;
    const bottomWeight = migrated.w_index_bottom ?? 0.05;
    migrated.key_effort = Object.fromEntries(SECOND_KEYS.map((key) => {
      const meta = KEYMAP[key];
      const value = effortScale * (fingerEffort[meta.finger] ?? fallbackFinger[meta.finger]) +
        (meta.row === "top" ? topWeight : 0) +
        (meta.stretch ? stretchWeight : 0) +
        (meta.row === "bottom" ? bottomWeight : 0);
      return [key, value];
    }));
    migrated.w_effort = 1;
  }
  delete migrated.finger_effort;
  delete migrated.w_top;
  delete migrated.w_index_stretch;
  delete migrated.w_index_bottom;
  const old = migrated.pen_flow || (migrated.pen_flow = {});
  const flowScale = migrated.w_flow || 1;
  if (old.sfb == null) old.sfb = (migrated.w_sfb ?? 3.0) / flowScale;
  if (old.sfs == null) old.sfs = (migrated.w_sfs ?? migrated.w_skip ?? 0.5) / flowScale;
  delete migrated.w_sfb;
  delete migrated.w_sfs;
  delete migrated.w_skip;
  if (old) {
    if (old.goodRedirect == null && old.redirect != null) old.goodRedirect = old.alt ?? 0.5;
    if (old.badRedirect == null && old.redirect != null) old.badRedirect = old.redirect;
    if (old.goodRoll == null && (old.inroll != null || old.outroll != null)) {
      old.goodRoll = Math.min(old.inroll ?? Infinity, old.outroll ?? Infinity);
    }
    // 旧 good/bad redirect → index/pinky/middle redirect(pinky と middle は旧 bad を引き継ぐ)。
    if (old.indexRedirect == null && old.goodRedirect != null) old.indexRedirect = old.goodRedirect;
    if (old.pinkyRedirect == null && old.badRedirect != null) old.pinkyRedirect = old.badRedirect;
    if (old.middleRedirect == null && old.badRedirect != null) old.middleRedirect = old.badRedirect;
    delete old.goodRedirect;
    delete old.badRedirect;
  }
  return migrated;
}

// ================= グリッド構築 =================
// 最初の右手キー(左右境界のセパレータ用)。
const SEP_KEY = SECOND_KEYS.find((k) => KEYMAP[k].hand === "R");

// 現在のレイアウトから単打キー集合/行列スロットを導出(単打キーの位置は可変)。
const getSingleKeys = () => singleKeysOf(state.layout);
const getMatSlots = () => matSlotsOf(getSingleKeys());

// グリッド・単打パネルは単打キー集合に依存する。集合が変わったら再構築する。
let builtSingleSig = null;
function ensureStructure() {
  const sig = getSingleKeys().join(",");
  if (sig === builtSingleSig) return;
  builtSingleSig = sig;
  buildGrid();
}

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
  const singleKeys = getSingleKeys();
  grid.style.gridTemplateColumns = `26px repeat(${SECOND_KEYS.length}, minmax(30px, 1fr))`;
  grid.innerHTML = "";
  for (const k of Object.keys(cellEls)) delete cellEls[k];
  for (const k of Object.keys(gheadEls)) delete gheadEls[k];

  // ヘッダ行: 列 = 第1キー。単打キーは割当かなを「F/ん」形式で併記(renderGridで更新)。
  grid.appendChild(el("div", "ghead", "2\\1"));
  for (const f of SECOND_KEYS) {
    const h = el("div", "ghead" + (f === SEP_KEY ? " sep-l" : ""), f);
    gheadEls[f] = h;
    grid.appendChild(h);
  }

  // 単打行: 列ラベル直下。かなを置いたキーが単打になる(空=通常の第1キー)。
  // 行列セルと同じ見た目・同じドラッグ操作で交換できる。
  for (const k of Object.keys(singleEls)) delete singleEls[k];
  grid.appendChild(el("div", "rhead single-rhead", "単打"));
  for (const key of SECOND_KEYS) {
    const cell = document.createElement("div");
    cell.className = "slot single-cell" + (key === SEP_KEY ? " sep-l" : "");
    cell.dataset.single = key;
    cell.draggable = true;
    const fill = document.createElement("div");
    fill.className = "freq-fill";
    cell.appendChild(fill);
    const kv = document.createElement("span");
    kv.className = "kv";
    cell.appendChild(kv);
    const seq = document.createElement("span");
    seq.className = "seq";
    seq.textContent = key.toLowerCase();
    cell.appendChild(seq);
    cell._kv = kv;
    cell._fill = fill;
    attachCellEvents(cell, "single", key);
    singleEls[key] = cell;
    grid.appendChild(cell);
  }

  // 本体: 行 = 第2キー、列 = 第1キー。単打キーの列は無効セルとして描画する。
  SECOND_KEYS.forEach((s) => {
    grid.appendChild(
      el("div", "rhead" + (s === SEP_KEY ? " sep-t" : ""), s)
    );
    SECOND_KEYS.forEach((f) => {
      const single = singleKeys.includes(f);
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

// key を単打化して kana を割り当てる。key列の占有かなは空きスロットへ退避する。
// fromSlot はドラッグ元の行列スロット(あれば空ける)。空きが足りなければ false。
function makeSingle(key, kana, fromSlot) {
  const mat = state.layout.mat;
  const occupants = [];
  for (const s of SECOND_KEYS) {
    const slot = key + s;
    if (slot !== fromSlot && mat[slot]) occupants.push(mat[slot]);
  }
  const newSlots = matSlotsOf([...getSingleKeys(), key]);
  const newMat = {};
  for (const slot of newSlots) newMat[slot] = mat[slot] || "";
  if (fromSlot && fromSlot in newMat) newMat[fromSlot] = "";
  const empties = newSlots.filter((s) => !newMat[s]);
  if (empties.length < occupants.length) {
    alert("空きスロットが足りないため単打化できません");
    return false;
  }
  occupants.forEach((k, i) => { newMat[empties[i]] = k; });
  state.layout.mat = newMat;
  state.layout.single[key] = kana;
  return true;
}

// key の単打を解除して通常の第1キーへ戻す(列のスロットが復活する)。
// 割当かなの行き先スロットを toSlot で指定できる(省略時はどこにも置かない)。
function unmakeSingle(key, toSlot) {
  const kana = state.layout.single[key];
  delete state.layout.single[key];
  const mat = state.layout.mat;
  const newMat = {};
  for (const slot of getMatSlots()) newMat[slot] = mat[slot] || "";
  if (toSlot && kana) newMat[toSlot] = kana;
  state.layout.mat = newMat;
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
    if (dragSrc) {
      e.preventDefault();
      cell.classList.add("dragover");
    }
  });
  cell.addEventListener("dragleave", () => cell.classList.remove("dragover"));
  cell.addEventListener("drop", (e) => {
    e.preventDefault();
    cell.classList.remove("dragover");
    if (dragSrc && (dragSrc.kind !== kind || dragSrc.id !== id)) {
      if (dragSrc.kind === kind) {
        swap(kind, dragSrc.id, id);
      } else {
        // 行列⇄単打のクロススワップ(かなを単打にする/行列へ戻す)。
        const matSlot = kind === "mat" ? id : dragSrc.id;
        const singleKey = kind === "single" ? id : dragSrc.id;
        swapCross(matSlot, singleKey);
      }
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
    onLayoutEdited();
  } else {
    swapSingles(a, b);
  }
}

// 単打セル同士の入替。単打の有効/無効は「かながあるか」に従うので、
// 空セルへ動かした場合は移動元の単打を解除し、移動先を単打化する。
function swapSingles(a, b) {
  const single = state.layout.single;
  const hasA = a in single, hasB = b in single;
  if (!hasA && !hasB) return; // 両方空
  if (hasA && hasB) {
    const t = single[a];
    single[a] = single[b];
    single[b] = t;
    onLayoutEdited();
    return;
  }
  const [from, to] = hasA ? [a, b] : [b, a];
  const kana = single[from];
  unmakeSingle(from); // 先に解除すると from 列が開き、退避先の空きが増える
  if (!makeSingle(to, kana, null)) {
    makeSingle(from, kana, null); // 失敗時は元の単打へ戻す(列は空なので必ず成功)
    return;
  }
  onLayoutEdited();
}

// 行列スロット⇄単打セルの入替。単打の有効/無効は「かながあるか」に従う:
//   空の単打セルへ置く → そのキーを単打化(列のかなは空きへ退避)
//   単打かなを行列の空セルへ出す → 単打解除(列が復活)
function swapCross(matSlot, singleKey) {
  const single = state.layout.single;
  const mat = state.layout.mat;
  const matKana = mat[matSlot] || "";
  if (singleKey in single) {
    if (!matKana) {
      unmakeSingle(singleKey, matSlot);
    } else {
      mat[matSlot] = single[singleKey];
      single[singleKey] = matKana;
    }
    onLayoutEdited();
  } else {
    if (!matKana) return; // 空→空は無意味
    if (makeSingle(singleKey, matKana, matSlot)) onLayoutEdited();
  }
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
  const moraKeys = buildMoraKeys(state.layout, state.yoonSplit);
  const candidates = [];
  for (const slot of getMatSlots()) {
    if (slot === curSlot) continue;
    const occ = mat[slot];
    if (occ === mora) continue;
    candidates.push({ slot, occ });
  }
  const { baseCost, results, tweak } = suggestPlacements(
    state.ngram, state.weights, moraKeys, mora, curSlot, candidates, 6, 0.0005, unitsOfMora);
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
  FLOW_BREAK_TYPES.forEach((t) => {
    const max = t === "sfb" || t === "sfs" ? 10 : 3;
    box.appendChild(breakRow("flow", t, [["pen_flow", t]], ["重み"], t, max));
  });
}

// 連接内訳の1行: [種別 | 現状値 | (ラベル+スライダー+重み値)...]。
// labelText を省略すると type をそのまま行ラベルに使う。
function breakRow(kind, type, paths, labels, labelText = type, max = 3) {
  const row = document.createElement("div");
  const wide = labelText !== type ? " bkw" : ""; // 文脈付きラベル(例 roll・ういん)は幅広に。
  row.className = "bk" + (paths.length > 1 ? " bk2" : "") + wide;
  let html = `<span class="l">${labelText}</span><span class="bv2" data-${kind}="${type}">–</span>`;
  paths.forEach((p, i) => {
    const key = p.join(".");
    html += `<span class="sw">` +
      `<span class="swl">${labels[i]}</span>` +
      `<input type="range" min="0" max="${max}" step="0.05" data-wpath="${key}">` +
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
  SECOND_KEYS.forEach((key) => {
    const row = document.createElement("div");
    row.className = "load-row";
    row.innerHTML = `<span class="bl">${key}</span>
      <div class="bar-track"><div class="bar-fill" data-load="${key}"></div></div>
      <span class="bv" data-loadv="${key}">–</span>
      <input type="range" min="0" max="5" step="0.05" data-wpath="key_effort.${key}">
      <span class="wv" data-wv="key_effort.${key}"></span>`;
    const slider = row.querySelector("input");
    slider.value = getP(state.weights, ["key_effort", key]);
    slider.addEventListener("input", () => {
      setP(state.weights, ["key_effort", key], parseFloat(slider.value));
      onWeightsChanged();
    });
    box.appendChild(row);
  });
}

// ================= 計算 =================
function recomputeLocal() {
  state.metrics = computeMetrics(
    state.layout, state.ngram, state.weights,
    buildMoraKeys(state.layout, state.yoonSplit));
}

// ================= 描画 =================
function renderAll() {
  renderGrid();
  renderSingles();
  renderMetrics();
  renderWeightValues();
  renderDetailPanel();
  renderFlowExample();
  renderWeakPoints();
  renderIter();
}

function renderGrid() {
  ensureStructure();
  const moraKeys = buildMoraKeys(state.layout, state.yoonSplit);
  const neighbors = computeNeighbors(moraKeys);
  // タイピング練習の現在かな: 2キーなら行列スロット、1キーなら単打キーを発光。
  const tKeys = state.typingKana ? moraKeys[state.typingKana] : null;
  const tSlot = tKeys && tKeys.length === 2 ? tKeys[0] + tKeys[1] : null;
  const tSingle = tKeys && tKeys.length === 1 ? tKeys[0] : null;
  // 列ヘッダ: 単打キーは割当かなを併記(割当は再構築なしでも変わるので毎回更新)。
  // 練習中の単打かなはヘッダも発光させる。
  for (const [key, h] of Object.entries(gheadEls)) {
    const kana = state.layout.single[key];
    if (key in state.layout.single) {
      h.innerHTML = `${escapeHtml(key)}<span class="gh-kana">/${escapeHtml(kana || "–")}</span>`;
    } else if (h.textContent !== key) {
      h.textContent = key;
    }
    h.classList.toggle("typing-target", key === tSingle);
  }
  for (const slot of getMatSlots()) {
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
  ensureStructure();
  const moraKeys = buildMoraKeys(state.layout, state.yoonSplit);
  const tKeys = state.typingKana ? moraKeys[state.typingKana] : null;
  const tSingle = tKeys && tKeys.length === 1 ? tKeys[0] : null;
  for (const key of SECOND_KEYS) {
    const cell = singleEls[key];
    if (!cell) continue;
    const kana = state.layout.single[key] || "";
    cell._kv.textContent = kana;
    const freq = kana ? (state.ngram.unigram[kana] || 0) : 0;
    const w = state.ngram.refFreq > 0 ? Math.min(100, freq / state.ngram.refFreq * 100) : 0;
    cell._fill.style.width = w + "%";
    cell.classList.toggle("empty", !kana);
    cell.classList.toggle("rare", isRare(kana));
    cell.classList.toggle("selected", isSelected("single", key));
    cell.classList.toggle("locked", state.lockSingle);
    cell.classList.toggle("typing-target", key === tSingle);
  }
}

function isSelected(kind, id) {
  return state.selected && state.selected.kind === kind && state.selected.id === id;
}

// 選択モーラの前後 top 連接先セルを近傍としてハイライト。
function computeNeighbors(moraKeys) {
  const set = new Set();
  if (!state.selected || !state.selected.mora) return set;
  const mora = state.selected.mora;
  // 分解モードでは拗音の構成単位(し・ゃ等)としての出現もマッチさせる。
  const matches = (m) => m === mora || (unitsOfMora(m) || []).includes(mora);
  const partners = [];
  for (const [m1, m2, c] of state.ngram.bigramList) {
    if (matches(m1)) partners.push([m2, c]);
    else if (matches(m2)) partners.push([m1, c]);
  }
  partners.sort((a, b) => b[1] - a[1]);
  const slotOf = {};
  for (const slot of getMatSlots()) {
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
  // 物理キーごとの使用率。
  SECOND_KEYS.forEach((key) => {
    const v = m.keyLoads[key] || 0;
    const fill = document.querySelector(`[data-load="${key}"]`);
    const val = document.querySelector(`[data-loadv="${key}"]`);
    if (fill) fill.style.width = Math.min(100, v * 100 * 5) + "%";
    if (val) val.textContent = fmtPct(v);
  });
  // 連接内訳(現状値)
  FLOW_BREAK_TYPES.forEach((t) => {
    const s = document.querySelector(`[data-flow="${t}"]`);
    if (s) s.textContent = fmtPct(m.flowRates[t] || 0);
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
  const moraKeys = buildMoraKeys(state.layout, state.yoonSplit);
  const mora = state.selected ? state.selected.mora : null;
  renderDetail($("detail"), mora, state.ngram, moraKeys, state.suggest, unitsOfMora);
}

// 例文を現在の配置で打鍵したときの連接分類を可視化(実ストリーム)。
function renderFlowExample() {
  const box = $("flowExample");
  if (!box) return;
  const moraKeys = buildMoraKeys(state.layout, state.yoonSplit);
  const input = $("flowExampleInput");
  const moras = textToMoras(input ? input.value : "", Object.keys(moraKeys));
  const { keys, steps } = classifyStream(moras, moraKeys);

  const counts = {};
  for (const step of steps) {
    for (const cat of step.cats || [step.cat]) {
      if (cat !== "none") counts[cat] = (counts[cat] || 0) + 1;
    }
  }

  let html = `<div class="flowex-stream">`;
  keys.forEach((k, i) => {
    // 左手/右手で色分けし、手の連続(同手が続く区間)を視認しやすくする。
    const hand = k.key ? " hand-" + KEYMAP[k.key].hand.toLowerCase() : "";
    const cls = "flowex-key" + hand + (k.key ? "" : " unplaced");
    const keyText = k.key ? k.key.toLowerCase() : "?";
    html += `<span class="${cls}"><span class="fk-key">${escapeHtml(keyText)}</span><span class="fk-mora">${escapeHtml(k.mora)}</span></span>`;
    if (i < steps.length) {
      const cats = steps[i].cats || [steps[i].cat];
      const labels = cats.map((cat) => {
        const meta = FLOW_CAT_META[cat];
        return `<span class="flowex-op cat-${cat}" title="${meta ? meta.legend : "未配置"}">${meta ? meta.label : "–"}</span>`;
      }).join("");
      html += `<span class="flowex-ops">${labels}</span>`;
    }
  });
  html += `</div>`;

  const handLegend =
    `<span class="lg"><i class="hand-sw-l"></i>左手</span>` +
    `<span class="lg"><i class="hand-sw-r"></i>右手</span>`;
  const legend = FLOW_BREAK_TYPES.map((c) => {
    const meta = FLOW_CAT_META[c];
    return `<span class="lg"><i class="cat-${c}"></i>${meta.legend} ${counts[c] || 0}</span>`;
  }).join("");
  html += `<div class="flowex-legend">${handLegend}${legend}</div>`;

  box.innerHTML = html;
}

// 配列の弱点: sfb / repeat / pinky・middle redirect を引き起こすバイモーラの頻度ランキング。
const WEAK_CATS = ["sfb", "repeat", "pinkyRedirect", "middleRedirect"];
function renderWeakPoints() {
  const box = $("weakPoints");
  if (!box) return;
  const moraKeys = buildMoraKeys(state.layout, state.yoonSplit);
  const weak = collectWeakPoints(state.ngram, moraKeys, 10);
  const cols = WEAK_CATS.map((cat) => {
    const meta = FLOW_CAT_META[cat];
    const rows = weak[cat].map((e) => `<div class="wk-row">
        <span class="wk-pair">${escapeHtml(e.m1 + e.m2)}</span>
        <span class="wk-keys">${escapeHtml(e.keys.toLowerCase())}</span>
        <span class="wk-val">${fmtPct(e.rate)}</span>
      </div>`).join("") || `<div class="wk-empty">なし</div>`;
    return `<div class="weak-col">
      <span class="wk-head cat-${cat}">${meta.legend}</span>
      ${rows}
    </div>`;
  }).join("");
  box.innerHTML = `<div class="weak-cols">${cols}</div>`;
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
  // 拗音モードの切り替えは最適化中に不可(ワーカー側の状態と食い違うため)。
  const yoonCb = $("yoonSplit");
  if (yoonCb) yoonCb.disabled = state.optimizing || state.stopping;
}

// ================= ツールバー・最適化 =================
function wireToolbar() {
  $("btnOptimize").addEventListener("click", toggleOptimize);
  $("btnPolish").addEventListener("click", togglePolish);
  $("btnReset").addEventListener("click", () => {
    state.layout = defaultLayout();
    enforceYoonMode(); // 分解モード中は拗音・外来語音を外して ゃゅょ を配置し直す
    onLayoutEdited();
  });
  $("btnExport").addEventListener("click", openExport);
  $("btnImport").addEventListener("click", openImport);
  $("btnKarabiner").addEventListener("click", openKarabiner);
  $("flowExampleInput").addEventListener("input", renderFlowExample);

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

  // 拗音分解モード。最適化中は切り替え不可(チェックボックスは renderIter で無効化)。
  const yoonCb = $("yoonSplit");
  yoonCb.checked = state.yoonSplit;
  yoonCb.addEventListener("change", () => {
    if (state.optimizing || state.stopping) {
      yoonCb.checked = state.yoonSplit;
      return;
    }
    applyYoonMode(yoonCb.checked);
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
    renderWeakPoints();
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
      yoonSplit: state.yoonSplit,
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
    yoonSplit: state.yoonSplit,
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
      enforceYoonMode(); // 分解モード中に一体形式をインポートした場合も不変条件を保つ
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
