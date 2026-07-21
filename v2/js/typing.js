// タイピング練習パネル。
// jap-n.txt(ローマ字コーパス)の一節をモーラ列にし、かな直配列(Karabiner)が
// IME へ送出する「かな直ローマ字」(KANA_TO_ROMAJI, 例: き→ki, ゃ→lya)を
// 1打鍵=1文字で照合する。ミスは赤表示・Backspace 無効・カーソルは正打まで進まない。
//
// 表示・照合の単位は「練習単位」: 通常はモーラそのもの、拗音分解モードでは
// expandMora により しゃ→し+ゃ のように単位かなへ展開される。
// 元のモーラ列(rawMoras)を保持しているので、モード切替時は refresh() で
// 同じ一節を現在のモードの単位に組み直せる。

import { romajiToMoras, BREAK } from "./romaji.js";
import { KANA_TO_ROMAJI } from "./karabiner.js";

// かな直ローマ字の逆引きとプレフィックス集合。
// 複数文字で1かなをなすため、バッファに溜めて「1かな分」確定してから照合する。
const ROMAJI_TO_KANA = {};
const ROMAJI_PREFIXES = new Set();
for (const [kana, romaji] of Object.entries(KANA_TO_ROMAJI)) {
  ROMAJI_TO_KANA[romaji] = kana;
  for (let l = 1; l < romaji.length; l++) ROMAJI_PREFIXES.add(romaji.slice(0, l));
}

// バッファの状態: {done, invalid, kana}。
//   done=true  … 1かな分が確定(kana にそのかな)
//   invalid    … どのかなにもならないゴミ入力
//   それ以外   … プレフィックス途中(続きを待つ)
function matchBuffer(buf) {
  if (ROMAJI_PREFIXES.has(buf)) return { done: false, invalid: false, kana: "" };
  const kana = ROMAJI_TO_KANA[buf];
  if (kana) return { done: true, invalid: false, kana };
  return { done: false, invalid: true, kana: "" };
}

class TypingPanel {
  // root: パネルのコンテナ要素。corpus: コーパス全文。
  // onKana(kana|null): 現在打つべき単位かなの通知(マトリックス発光用)。
  // expandMora(mora): モーラ→練習単位かな配列(モードに応じて main が与える)。
  constructor(root, corpus, onKana, expandMora) {
    this.corpus = (corpus || "").replace(/\s+/g, " ").trim();
    this.onKana = onKana || (() => {});
    this.expandMora = expandMora || ((m) => [m]);
    this.focused = false;

    root.innerHTML = `
      <div class="typing-bar">
        <span class="tp-title">タイピング練習</span>
        <button class="tp-new">新しい一節</button>
        <button class="tp-retry">やり直す</button>
        <span class="tp-stats"></span>
      </div>
      <div class="typing-passage" tabindex="0"></div>`;
    this.passageEl = root.querySelector(".typing-passage");
    this.statsEl = root.querySelector(".tp-stats");

    this.passageEl.addEventListener("keydown", (e) => this.onKey(e));
    this.passageEl.addEventListener("focus", () => { this.focused = true; this.notify(); });
    this.passageEl.addEventListener("blur", () => { this.focused = false; this.notify(); });
    root.querySelector(".tp-new").addEventListener("click", () => {
      this.load(this.pickRawMoras());
      this.passageEl.focus();
    });
    root.querySelector(".tp-retry").addEventListener("click", () => {
      this.load(this.rawMoras);
      this.passageEl.focus();
    });

    this.load(this.pickRawMoras());
  }

  // コーパスからランダムに切り出し、練習単位数が targetUnits に達するまでのモーラ列を返す。
  pickRawMoras(targetUnits = 90) {
    if (this.corpus.length < 400) return [];
    const maxStart = Math.max(1, this.corpus.length - 600);
    let start = Math.floor(Math.random() * maxStart);
    // 単語の途中から始まらないよう、直近の区切りまで送る。
    const nb = this.corpus.slice(start, start + 60).search(/[.,\s]/);
    if (nb !== -1) start += nb + 1;
    while (start < this.corpus.length && /\s/.test(this.corpus[start])) start++;

    const raws = [];
    let unitCount = 0;
    for (const mora of romajiToMoras(this.corpus.slice(start, start + 600))) {
      if (mora === BREAK) continue;
      const units = this.unitsOf(mora);
      if (units.length === 0) continue; // かな直ローマ字が無いモーラ(稀)はスキップ
      raws.push(mora);
      unitCount += units.length;
      if (unitCount >= targetUnits) break;
    }
    return raws;
  }

  // モーラ→練習単位 [{kana, romaji}]。ローマ字が引けない単位を含むモーラは除外。
  unitsOf(mora) {
    const units = this.expandMora(mora).map((kana) => ({ kana, romaji: KANA_TO_ROMAJI[kana] }));
    return units.every((u) => u.romaji) ? units : [];
  }

  // 一節をロードして練習状態をリセットする。rawMoras は展開前のモーラ列。
  load(rawMoras) {
    this.rawMoras = rawMoras || [];
    this.units = this.rawMoras.flatMap((m) => this.unitsOf(m));
    this.cursor = 0;
    this.buf = "";
    this.status = new Array(this.units.length); // "ok" | "err" | undefined
    this.curErred = false;   // 現在の単位で誤打したか
    this.missText = "";      // 打ち間違い表示(正打まで残す)
    this.mistakes = 0;
    this.startTime = 0;
    this.done = this.units.length === 0;
    this.render();
    this.renderStats();
    this.notify();
  }

  // 拗音分解モードの切替後など、同じ一節を現在の単位定義で組み直す。
  refresh() {
    this.load(this.rawMoras);
  }

  notify() {
    const active = this.focused && !this.done && this.units.length > 0;
    this.onKana(active ? this.units[this.cursor].kana : null);
  }

  onKey(e) {
    if (this.done) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Backspace") { e.preventDefault(); return; } // 消せない
    if (e.key.length !== 1) return;
    e.preventDefault();

    if (!this.startTime) this.startTime = performance.now();
    const buf = this.buf + e.key.toLowerCase();
    const m = matchBuffer(buf);

    if (m.invalid) {
      // どのかなにもならないゴミ入力: 誤打として捨てる。
      this.miss(buf);
    } else if (!m.done) {
      // 1かな分に満たない。溜めて次を待つ。
      this.buf = buf;
    } else if (m.kana === this.units[this.cursor].kana) {
      // 正解: 前進。
      this.buf = "";
      this.missText = "";
      this.status[this.cursor] = this.curErred ? "err" : "ok";
      this.curErred = false;
      this.cursor++;
      if (this.cursor >= this.units.length) this.done = true;
      this.notify();
    } else {
      // 別のかなを打った: 前進せず赤表示。
      this.buf = "";
      this.miss(m.kana);
    }
    this.render();
    this.renderStats();
  }

  miss(text) {
    this.buf = "";
    this.mistakes++;
    this.curErred = true;
    this.missText += text;
  }

  render() {
    let html = "";
    this.units.forEach((u, i) => {
      let cls = "tp-char";
      if (this.status[i] === "ok") cls += " ok";
      else if (this.status[i] === "err") cls += " err";
      if (i === this.cursor && !this.done) {
        cls += " cur";
        if (this.missText) html += `<span class="tp-miss">${escapeHtml(this.missText)}</span>`;
      }
      html += `<span class="${cls}">${escapeHtml(u.kana)}</span>`;
    });
    if (this.done && this.units.length) html += `<span class="tp-done">完了！</span>`;
    this.passageEl.innerHTML = html;
    const cur = this.passageEl.querySelector(".cur");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  renderStats() {
    const total = this.units.length;
    const doneN = this.cursor;
    const errN = this.status.slice(0, doneN).filter((s) => s === "err").length;
    const acc = doneN > 0 ? ((doneN - errN) / doneN) * 100 : 100;
    let upm = 0;
    if (this.startTime) {
      const min = (performance.now() - this.startTime) / 60000;
      if (min > 0) upm = doneN / min;
    }
    this.statsEl.textContent =
      `${doneN}/${total} かな　ミス ${this.mistakes}　正確率 ${acc.toFixed(1)}%　${upm.toFixed(0)} かな/分`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// root にパネルを構築して TypingPanel を返す。
// onKanaCb(kana|null): 現在の単位かなの通知。expandMora: モーラ→練習単位配列。
export function initTyping(root, corpus, onKanaCb, expandMora) {
  return new TypingPanel(root, corpus, onKanaCb, expandMora);
}
