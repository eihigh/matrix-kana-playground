// レイアウトと重みの import/export / localStorage 保存。

import { MAT_SLOTS, SINGLE_KEYS, cloneLayout } from "./layout.js";

const LS_KEY = "kanachoku_v2";

// レイアウト＋メタ情報を JSON 文字列にする。
export function exportLayoutJSON(layout, metrics) {
  const payload = {
    _meta: {
      name: "かな直",
      cost: metrics?.cost,
      topRatio: metrics?.topRatio,
      effort: metrics?.effort,
      sfbRate: metrics?.sfbRate,
      flowUni: metrics?.flowUni,
      flowBi: metrics?.flowBi,
      note: "かな直 v2 配列。mat=行列(13×16=208), single=単打(F/J/K)。",
    },
    mat: { ...layout.mat },
    single: { ...layout.single },
  };
  return JSON.stringify(payload, null, 2);
}

// JSON 文字列をレイアウトへ変換。旧来のフラット形式にも一応対応。
export function parseLayoutJSON(text) {
  const obj = JSON.parse(text);
  const mat = {};
  const single = {};
  const src = obj.mat && obj.single ? obj : null;
  if (src) {
    for (const slot of MAT_SLOTS) mat[slot] = src.mat[slot] || "";
    for (const key of SINGLE_KEYS) single[key] = src.single[key] || "";
  } else {
    // フラット形式(slotId をトップレベルに持つ)。
    for (const slot of MAT_SLOTS) mat[slot] = obj[slot] || "";
    for (const key of SINGLE_KEYS) single[key] = obj[key] || "";
  }
  return { mat, single };
}

export function saveLocal(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      layout: data.layout,
      weights: data.weights,
      lockSingle: !!data.lockSingle,
      keyCodes: data.keyCodes || null,
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
      layout: cloneLayout(obj.layout),
      weights: obj.weights || null,
      lockSingle: !!obj.lockSingle,
      keyCodes: obj.keyCodes || null,
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
