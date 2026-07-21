// レイアウトと重みの import/export / localStorage 保存。

import { SECOND_KEYS, SINGLE_KEYS, SINGLE_KANA, matSlotsOf } from "./layout.js";

const LS_KEY = "kanachoku_v2";

// レイアウトを検証・正規化する。単打キーの位置・割当・個数は入力の layout.single に従う
// (自由化: どのキーが単打か、何を単打にするかは事前に決めない)。
// - 単打は「かなが割り当てられているキー」のみ(空エントリは単打でないとして落とす)
// - single が未定義のときだけ既定(F/J に ん・い)へフォールバック(空オブジェクトは単打なしとして尊重)
// - 行列は単打キー集合から導出したスロットのみ保持
// - かなの重複は単打優先→行列先勝ちで除去
export function normalizeLayout(layout) {
  const single = {};
  const used = new Set();
  for (const [key, kana] of Object.entries(layout?.single || {})) {
    if (!SECOND_KEYS.includes(key) || key in single) continue;
    if (kana && !used.has(kana)) {
      single[key] = kana;
      used.add(kana);
    }
  }
  if (layout?.single == null) {
    SINGLE_KEYS.forEach((key, i) => { single[key] = SINGLE_KANA[i]; used.add(SINGLE_KANA[i]); });
  }

  const mat = {};
  for (const slot of matSlotsOf(Object.keys(single))) {
    const kana = layout?.mat?.[slot] || "";
    if (kana && !used.has(kana)) {
      mat[slot] = kana;
      used.add(kana);
    } else {
      mat[slot] = "";
    }
  }
  return { mat, single };
}

// レイアウト＋メタ情報を JSON 文字列にする。
export function exportLayoutJSON(layout, metrics) {
  const payload = {
    _meta: {
      name: "かな直",
      cost: metrics?.cost,
      effort: metrics?.effort,
      sfbRate: metrics?.sfbRate,
      sfsRate: metrics?.sfsRate,
      flow: metrics?.flow,
      strokes: metrics?.strokes,
      note: "かな直 v2 配列。mat=行列(第1キー×第2キー), single=単打(キー位置は可変)。人差し指拡張版(G/H/V/M)。",
    },
    mat: { ...layout.mat },
    single: { ...layout.single },
  };
  return JSON.stringify(payload, null, 2);
}

// JSON 文字列をレイアウトへ変換。旧来のフラット形式にも一応対応。
export function parseLayoutJSON(text) {
  const obj = JSON.parse(text);
  if (obj.mat && obj.single) {
    return normalizeLayout({ mat: obj.mat, single: obj.single });
  }
  // フラット形式(slotId をトップレベルに持つ。単打は既定キーから拾う)。
  const mat = {};
  const single = {};
  for (const key of SINGLE_KEYS) single[key] = obj[key] || "";
  for (const slot of matSlotsOf(SINGLE_KEYS)) mat[slot] = obj[slot] || "";
  return normalizeLayout({ mat, single });
}

export function saveLocal(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      layout: data.layout,
      weights: data.weights,
      lockSingle: !!data.lockSingle,
      keyCodes: data.keyCodes || null,
      yoonSplit: !!data.yoonSplit,
      yoonStash: data.yoonStash || null,
    }));
  } catch (_) { /* localStorage 不可時は無視 */ }
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj.layout) return null;
    return {
      layout: normalizeLayout(obj.layout),
      weights: obj.weights || null,
      lockSingle: !!obj.lockSingle,
      keyCodes: obj.keyCodes || null,
      yoonSplit: !!obj.yoonSplit,
      yoonStash: obj.yoonStash || null,
    };
  } catch (_) {
    return null;
  }
}

// テキストをファイルとしてダウンロードさせる。
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
