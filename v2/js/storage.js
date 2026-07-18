// レイアウトと重みの import/export / localStorage 保存。

import { MAT_SLOTS, SINGLE_KEYS, SINGLE_KANA } from "./layout.js";

const LS_KEY = "kanachoku_v2";

// 旧F/J/K単打レイアウトを含む入力を、F/J単打＋「う」行列配置へ正規化する。
export function normalizeLayout(layout) {
  const mat = Object.fromEntries(MAT_SLOTS.map((slot) => [slot, layout?.mat?.[slot] || ""]));
  for (const slot of MAT_SLOTS) {
    if (SINGLE_KANA.includes(mat[slot])) mat[slot] = "";
  }
  if (!Object.values(mat).includes("う")) {
    const emptySlot = MAT_SLOTS.find((slot) => !mat[slot]);
    if (emptySlot) mat[emptySlot] = "う";
  }

  const single = {};
  const used = new Set();
  for (const key of SINGLE_KEYS) {
    const kana = layout?.single?.[key];
    if (SINGLE_KANA.includes(kana) && !used.has(kana)) {
      single[key] = kana;
      used.add(kana);
    } else {
      single[key] = "";
    }
  }
  const missing = SINGLE_KANA.filter((kana) => !used.has(kana));
  for (const key of SINGLE_KEYS) {
    if (!single[key]) single[key] = missing.shift() || "";
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
      note: "かな直 v2 配列。mat=行列(18×20=360), single=単打(F/J)。人差し指拡張版(G/H/V/M)。",
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
  return normalizeLayout({ mat, single });
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
      layout: normalizeLayout(obj.layout),
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
