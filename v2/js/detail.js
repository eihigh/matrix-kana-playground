// 文字詳細パネル: 選択したモーラの「使用率（順位）」をコンパクトに、
// 前後を区別せず 該当モーラを含む bigram を「<2モーラ文字列> 割合」で一覧する。

// ngram = { unigram, bigramList, total, rank(Map mora->順位), types }
// moraKeys = { mora: [key,...] }(現在の配置。キー表示に使う)
export function renderDetail(container, mora, ngram, moraKeys) {
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

  // 前後を区別せず、選択モーラを含む bigram を割合の高い順に一覧。
  const list = [];
  for (const [m1, m2, c] of ngram.bigramList) {
    if (m1 === mora || m2 === mora) list.push({ pair: m1 + m2, count: c });
  }
  list.sort((a, b) => b.count - a.count);

  const rows = list.slice(0, 30).map((e) => {
    const p = ngram.total > 0 ? (e.count / ngram.total * 100) : 0;
    return `<div class="bg-row">
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
    <div class="detail-bigrams">${rows}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
