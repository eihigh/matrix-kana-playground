// 文字詳細パネル: 選択したモーラの「使用率（順位）」をコンパクトに、
// 前後を区別せず 該当モーラを含む bigram を「<2モーラ文字列> 割合」で一覧する。
// 各 bigram は現在の配置での連接分類でハイライトする。

import { classifyStream } from "./metrics.js";

// bigram(m1,m2)を現在の配置で分類し、"good" / "bad" / "" を返す。
//   good: 全連接が good roll/redirect。bad: bad roll/redirect か sfb を含む。
//   未配置キーを含む場合は評価不能として ""。
function classifyBigram(m1, m2, moraKeys) {
  const { steps } = classifyStream([m1, m2], moraKeys);
  if (steps.length === 0) return "";
  const categories = steps.flatMap((step) => step.cats || [step.cat]);
  if (categories.includes("none")) return "";
  if (categories.some((cat) => cat === "badRedirect" || cat === "badRoll" || cat === "sfb" || cat === "sfs")) return "bad";
  if (categories.every((cat) => cat === "goodRedirect" || cat === "goodRoll")) return "good";
  return "";
}

// ngram = { unigram, bigramList, total, rank(Map mora->順位), types }
// moraKeys = { mora: [key,...] }(現在の配置。キー表示に使う)
// suggest = { mora, curSlot, list:[{slot,partner,delta}], bestSet } | null
export function renderDetail(container, mora, ngram, moraKeys, suggest) {
  if (!mora) {
    container.innerHTML = `<div class="detail-empty">セルを選ぶと、そのかなの使用率（順位）と、前後を含む連接の割合が表示されます。</div>`;
    return;
  }

  const count = ngram.unigram[mora] || 0;
  const rate = ngram.total > 0 ? count / ngram.total : 0;
  const rank = ngram.rank.get(mora);
  const rankStr = rank ? `${rank}位` : "圏外";
  const keys = moraKeys[mora];
  const keyStr = keys ? keys.join("＋") : "未配置";

  // 配置サジェスト: このかなを別スロットへ置いた場合の総コスト変化(良い順)。
  let suggestHtml = "";
  if (suggest && suggest.mora === mora && suggest.list.length) {
    const items = suggest.list.map((s) => {
      const good = s.delta < 0;
      const sign = s.delta > 0 ? "+" : "";
      const partner = s.partner ? `⇄ ${escapeHtml(s.partner)}` : "（空き）";
      return `<div class="sg-row ${good ? "good" : "bad"}">
        <span class="sg-slot">${escapeHtml(s.slot.toLowerCase())}</span>
        <span class="sg-part">${partner}</span>
        <span class="sg-delta">${sign}${s.delta.toFixed(4)}</span>
      </div>`;
    }).join("");
    suggestHtml = `<div class="detail-suggest">
      <div class="sg-head">配置サジェスト（総コスト変化・良い順）${suggest.tweakSet ? ` ｜ 微調整可能 ${suggest.tweakSet.size} セル` : ""}</div>
      ${items}
    </div>`;
  }

  // 前後を区別せず、選択モーラを含む bigram を割合の高い順に一覧。
  const list = [];
  for (const [m1, m2, c] of ngram.bigramList) {
    if (m1 === mora || m2 === mora) list.push({ m1, m2, pair: m1 + m2, count: c });
  }
  list.sort((a, b) => b.count - a.count);

  const rows = list.slice(0, 30).map((e) => {
    const p = ngram.total > 0 ? (e.count / ngram.total * 100) : 0;
    const cls = classifyBigram(e.m1, e.m2, moraKeys);
    return `<div class="bg-row${cls ? " " + cls : ""}">
      <span class="bg-pair">${escapeHtml(e.pair)}</span>
      <span class="bg-val">${p.toFixed(3)}%</span>
    </div>`;
  }).join("") || `<div class="bg-empty">なし</div>`;

  container.innerHTML = `
    <div class="detail-head">
      <span class="detail-kana">${escapeHtml(mora)}</span>
      <span class="detail-usage">${(rate * 100).toFixed(3)}%（${rankStr}）</span>
      <span class="detail-keys">${escapeHtml(keyStr)}</span>
    </div>
    ${suggestHtml}
    <div class="detail-bigrams">${rows}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
