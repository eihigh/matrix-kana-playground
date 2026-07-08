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

// 現在の練習状態。
const st = {
  moras: [],      // [{ kana, romaji }]
  cursorM: 0,     // 現在のモーラ index
  cursorC: 0,     // 現在モーラ内のローマ字文字 index
  results: [],    // モーラ index -> "ok" | "err" | undefined(未完了)
  moraErr: [],    // モーラ index -> そのモーラで誤打があったか
  mistakes: 0,
  missFlash: false, // 直近の打鍵が誤打(正しく打つまで表示)
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
  st.cursorC = 0;
  st.results = new Array(moras.length);
  st.moraErr = new Array(moras.length).fill(false);
  st.mistakes = 0;
  st.missFlash = false;
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
    if (i === cursorM && !st.done) { cls += " cur"; if (st.missFlash) cls += " miss"; }
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
  const expected = m.romaji[st.cursorC];
  const ok = e.key.toLowerCase() === expected.toLowerCase();
  if (!ok) {
    // ミスは表示するが消費(前進)しない。正しく打つまでその位置に留まる。
    st.mistakes++;
    st.moraErr[st.cursorM] = true;
    st.missFlash = true;
    render();
    updateStats();
    return;
  }
  st.missFlash = false;
  st.cursorC++;
  if (st.cursorC >= m.romaji.length) {
    // モーラ完了。
    st.results[st.cursorM] = st.moraErr[st.cursorM] ? "err" : "ok";
    st.cursorM++;
    st.cursorC = 0;
    if (st.cursorM >= st.moras.length) st.done = true;
    notifyKana();
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
