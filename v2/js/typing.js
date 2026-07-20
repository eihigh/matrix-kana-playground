// タイピング練習パネル: jap-n.txt(ローマ字コーパス)の一節を「かな直のモーラ単位」に変換し、
// ひらがなで表示する。現在打つべき「かな(マトリックス用のそのモーラ)」を光らせる。
//
// 照合はそのかなの「かな直ローマ字」(KANA_TO_ROMAJI, 例: き→ki, し→si)で行う。
// jap-n.txt のローマ字とは一致しない前提なので、モーラへ直してから各かなの
// かな直ローマ字を期待入力とする。1打鍵=1文字で照合し、ミスは赤表示・Backspace 無効
// (消せない)、カーソルは常に前進する。

import { romajiToMoras, BREAK } from "./romaji.js";
import { KANA_TO_ROMAJI } from "./karabiner.js";

let CORPUS = ""; // 空白正規化した jap-n.txt 全文。

// かな直ローマ字(KANA_TO_ROMAJI)から逆引きとプレフィックス集合を用意。
// この配列では 1かな=固定のローマ字列。打鍵はアルファベットだが複数文字で
// 1かなをなすので、バッファに溜めて「1かな分」確定してから期待かなと突き合わせ、
// 違えば「打ってしまったかな」を赤字で表示する。
const ROMAJI_TO_KANA = {};
const ROMAJI_PREFIXES = new Set();
for (const [kana, r] of Object.entries(KANA_TO_ROMAJI)) {
  ROMAJI_TO_KANA[r] = kana;
  for (let l = 1; l < r.length; l++) ROMAJI_PREFIXES.add(r.slice(0, l));
}

// バッファ(これまでに打ったアルファベット)の状態を返す。
//  done  : 1かな分が確定(kana にそのかな)
//  それ以外で invalid=false : さらに打鍵を待つプレフィックス途中
//  invalid=true : どのかなにもならない(ゴミ入力)
function moraState(buf) {
  if (ROMAJI_PREFIXES.has(buf)) return { done: false, invalid: false, kana: "" };
  const kana = ROMAJI_TO_KANA[buf];
  if (kana) return { done: true, invalid: false, kana };
  return { done: false, invalid: true, kana: "" };
}

// 現在の練習状態。
const st = {
  moras: [],      // [{ kana, romaji }]
  cursorM: 0,     // 現在のモーラ index
  buf: "",        // 現モーラに向けて打ったアルファベット(未確定分)
  results: [],    // モーラ index -> "ok" | "err" | undefined(未完了)
  moraErr: [],    // モーラ index -> そのモーラで誤打があったか
  mistakes: 0,
  missFlash: false, // 直近のモーラが誤打(正しく打つまで表示)
  missKey: "",     // 打ち間違えたかな(赤字で挿入表示)
  startTime: 0,
  done: false,
};

let els = null;      // { passage, stats }
let onKana = () => {}; // 現在のかなをマトリックス側へ通知するコールバック
let focused = false;   // パネルがフォーカス中か(非フォーカス時は発光させない)

// 現在のかなをマトリックス強調用に通知。フォーカス中以外は null(消灯)。
function notifyKana() {
  onKana((focused && !st.done && st.moras.length) ? st.moras[st.cursorM].kana : null);
}

// コーパスからランダムに切り出し、モーラ列(BREAK除外・かな直ローマ字を持つもの)に変換。
function pickMoras(len = 90) {
  if (CORPUS.length < 400) return [];
  const maxStart = CORPUS.length - 600;
  let start = Math.floor(Math.random() * Math.max(1, maxStart));
  const nb = CORPUS.slice(start, start + 60).search(/[.,\s]/);
  if (nb !== -1) start += nb + 1;
  while (start < CORPUS.length && /\s/.test(CORPUS[start])) start++;
  // 十分な長さの生スライスをモーラ化して先頭 len 個を採用。
  const raw = CORPUS.slice(start, start + 600);
  const moras = [];
  for (const m of romajiToMoras(raw)) {
    if (m === BREAK) continue;
    const romaji = KANA_TO_ROMAJI[m];
    if (!romaji) continue; // かな直ローマ字が無いモーラ(稀)はスキップ
    moras.push({ kana: m, romaji });
    if (moras.length >= len) break;
  }
  return moras;
}

function load(moras) {
  st.moras = moras;
  st.cursorM = 0;
  st.buf = "";
  st.results = new Array(moras.length);
  st.moraErr = new Array(moras.length).fill(false);
  st.mistakes = 0;
  st.missFlash = false;
  st.missKey = "";
  st.startTime = 0;
  st.done = moras.length === 0;
  render();
  updateStats();
  notifyKana();
}

function render() {
  const { moras, cursorM, results } = st;
  let html = "";
  for (let i = 0; i < moras.length; i++) {
    let cls = "tp-char";
    if (results[i] === "ok") cls += " ok";
    else if (results[i] === "err") cls += " err";
    if (i === cursorM && !st.done) {
      cls += " cur";
      // 打ち間違えたかなを、これから打つかなの直前に赤字で差し込む。
      if (st.missFlash && st.missKey) {
        html += `<span class="tp-miss">${escapeHtml(st.missKey)}</span>`;
      }
    }
    html += `<span class="${cls}">${escapeHtml(moras[i].kana)}</span>`;
  }
  if (st.done && moras.length) html += `<span class="tp-done">完了！</span>`;
  els.passage.innerHTML = html;
  const cur = els.passage.querySelector(".cur");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function updateStats() {
  const total = st.moras.length;
  const doneM = st.cursorM;
  const errM = st.results.slice(0, doneM).filter((r) => r === "err").length;
  const acc = doneM > 0 ? ((doneM - errM) / doneM * 100) : 100;
  let kpm = 0;
  if (st.startTime) {
    const min = (performance.now() - st.startTime) / 60000;
    if (min > 0) kpm = doneM / min;
  }
  els.stats.textContent =
    `${doneM}/${total} かな　ミス ${st.mistakes}　正確率 ${acc.toFixed(1)}%　${kpm.toFixed(0)} かな/分`;
}

function onKey(e) {
  if (st.done) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Backspace") { e.preventDefault(); return; } // 消せない
  if (e.key.length !== 1) return; // 非文字キーは無視
  e.preventDefault();

  if (!st.startTime) st.startTime = performance.now();
  const m = st.moras[st.cursorM];
  const buf = st.buf + e.key.toLowerCase();
  const state = moraState(buf);

  if (state.invalid) {
    // どのかなにもならないゴミ入力。誤打として扱いバッファを捨てる。
    st.buf = "";
    st.mistakes++;
    st.moraErr[st.cursorM] = true;
    st.missFlash = true;
    st.missKey += buf;
    render();
    updateStats();
    return;
  }
  if (!state.done) {
    // まだ1かな分に満たない。バッファに溜めて次の打鍵を待つ。
    st.buf = buf;
    render();
    updateStats();
    return;
  }

  // 1かな分が確定。
  st.buf = "";
  if (state.kana === m.kana) {
    // 正解。
    st.missFlash = false;
    st.missKey = "";
    st.results[st.cursorM] = st.moraErr[st.cursorM] ? "err" : "ok";
    st.cursorM++;
    if (st.cursorM >= st.moras.length) st.done = true;
    notifyKana();
  } else {
    // 別のかなを打った=ミス。消費(前進)せず、打ったかなを赤字で表示。
    st.mistakes++;
    st.moraErr[st.cursorM] = true;
    st.missFlash = true;
    st.missKey += state.kana;
  }
  render();
  updateStats();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// root にパネルを構築。corpus は jap-n.txt の全文。onKanaCb(kana|null) で現在のかなを通知。
export function initTyping(root, corpus, onKanaCb) {
  CORPUS = (corpus || "").replace(/\s+/g, " ").trim();
  onKana = onKanaCb || (() => {});
  root.innerHTML = `
    <div class="typing-bar">
      <span class="tp-title">タイピング練習</span>
      <button class="tp-new">新しい一節</button>
      <button class="tp-retry">やり直す</button>
      <span class="tp-stats"></span>
    </div>
    <div class="typing-passage" tabindex="0"></div>`;

  els = {
    passage: root.querySelector(".typing-passage"),
    stats: root.querySelector(".tp-stats"),
  };

  els.passage.addEventListener("keydown", onKey);
  els.passage.addEventListener("focus", () => { focused = true; notifyKana(); });
  els.passage.addEventListener("blur", () => { focused = false; notifyKana(); });
  root.querySelector(".tp-new").addEventListener("click", () => { load(pickMoras()); els.passage.focus(); });
  root.querySelector(".tp-retry").addEventListener("click", () => { load(st.moras.map((m) => ({ ...m }))); els.passage.focus(); });

  load(pickMoras());
}
