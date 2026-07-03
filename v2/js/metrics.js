// optimize.py の fitness() をブラウザへ移植した指標計算。
// SFB は上限方式ではなく重み(w_sfb)で計上する。

import {
  FINGER_ORDER, FID, KEYMAP, classifyPair, buildMoraKeys,
} from "./layout.js";

// 既定の重み(optimize.py CONFIG に対応。sfb は重み方式へ変更)。
export function defaultWeights() {
  return {
    w_top: 1.0,
    w_effort: 1.0,
    w_order: 0.0,
    w_sfb: 1.0,
    w_flow_uni: 1.0,
    w_flow_bi: 1.0,
    finger_effort: {
      LP: 1.8, LR: 1.7, LM: 1.3, LI: 1.0,
      RI: 1.0, RM: 1.0, RR: 1.7, RP: 1.8,
    },
    // モーラ内(1-gram): roll_row は段移動を伴う同手ロール。
    pen_uni: { roll: 0.0, roll_row: 0.2, repeat: 0.5, alt: 0.5, sfb: 1.0 },
    // モーラ間(2-gram) ういん接続: ロール志向。
    pen_bi_uin: { roll: 0.0, alt: 0.5, repeat: 2.0, sfb: 1.0 },
    // モーラ間(2-gram) その他: alternation 志向。
    pen_bi_other: { alt: 0.0, roll: 0.8, repeat: 2.0, sfb: 1.0},
    // ういん接続と判定する単打かな。
    uin: ["う", "い", "ん"],
  };
}

// 段移動を伴う同手ロールか(home↔top)。
function isRollRow(k1, k2, type) {
  return type === "roll" && KEYMAP[k1].row !== KEYMAP[k2].row;
}

// layout = { mat, single }, ngram = { unigram, bigramList }, weights。
// 指標一式(cost と内訳)を返す。
export function computeMetrics(layout, ngram, weights) {
  const uni = ngram.unigram;
  const bigramList = ngram.bigramList;
  const w = weights;
  const uinSet = new Set(w.uin);

  const moraKeys = buildMoraKeys(layout);

  const finger = new Array(8).fill(0);
  let total = 0;      // キーストローク荷重和(loads/top の分母)
  let top = 0;
  let totalBg = 0;    // 連接荷重和(sfb_rate/flow の分母)
  let sfb = 0;

  let flowUniSum = 0, flowUniTot = 0;
  let flowBiSum = 0, flowBiTot = 0;
  const uniCnt = { roll: 0, roll_row: 0, alt: 0, repeat: 0, sfb: 0 };
  const biCnt = { roll: 0, alt: 0, repeat: 0, sfb: 0 };

  // 行列部・単打部: 指/段/effort と モーラ内バイグラム(1-gram流れ)
  for (const [mora, keys] of Object.entries(moraKeys)) {
    const freq = uni[mora] || 0;
    if (freq === 0) continue;
    if (keys.length === 2) {
      const [k0, k1] = keys;
      total += freq * 2;
      top += freq * ((KEYMAP[k0].row === "top" ? 1 : 0) + (KEYMAP[k1].row === "top" ? 1 : 0));
      finger[FID[KEYMAP[k0].finger]] += freq;
      finger[FID[KEYMAP[k1].finger]] += freq;
      totalBg += freq;
      const t = classifyPair(k0, k1);
      if (t === "sfb") sfb += freq;
      const pt = isRollRow(k0, k1, t) ? "roll_row" : t;
      flowUniSum += freq * w.pen_uni[pt];
      flowUniTot += freq;
      uniCnt[pt] += freq;
    } else {
      const k0 = keys[0];
      total += freq;
      top += freq * (KEYMAP[k0].row === "top" ? 1 : 0);
      finger[FID[KEYMAP[k0].finger]] += freq;
    }
  }

  // モーラ境界のキー連接(2-gram流れ)
  for (const [m1, m2, freq] of bigramList) {
    const k1 = moraKeys[m1];
    const k2 = moraKeys[m2];
    if (!k1 || !k2) continue;
    totalBg += freq;
    const a = k1[k1.length - 1];
    const b = k2[0];
    const t = classifyPair(a, b);
    if (t === "sfb") sfb += freq;
    const pen = (uinSet.has(m1) || uinSet.has(m2)) ? w.pen_bi_uin : w.pen_bi_other;
    flowBiSum += freq * pen[t];
    flowBiTot += freq;
    biCnt[t] += freq;
  }

  if (total <= 0 || totalBg <= 0) {
    return { cost: 1e9, valid: false };
  }

  const loads = finger.map((v) => v / total);
  const topRatio = top / total;
  const sfbRate = sfb / totalBg;

  const fe = w.finger_effort;
  let effort = 0;
  for (let i = 0; i < 8; i++) effort += fe[FINGER_ORDER[i]] * loads[i];

  const handPen = (p, r, m, idx) => {
    const mi = (m + idx) / 2;
    return Math.max(0, p - r) + Math.max(0, r - mi);
  };
  const orderPen =
    handPen(loads[FID.LP], loads[FID.LR], loads[FID.LM], loads[FID.LI]) +
    handPen(loads[FID.RP], loads[FID.RR], loads[FID.RM], loads[FID.RI]);

  const flowUni = flowUniTot > 0 ? flowUniSum / flowUniTot : 0;
  const flowBi = flowBiTot > 0 ? flowBiSum / flowBiTot : 0;

  const cost =
    w.w_top * topRatio +
    w.w_effort * effort +
    w.w_order * orderPen +
    w.w_sfb * sfbRate +
    w.w_flow_uni * flowUni +
    w.w_flow_bi * flowBi;

  const rates = (cnt, tot) => {
    const o = {};
    for (const k of Object.keys(cnt)) o[k] = tot > 0 ? cnt[k] / tot : 0;
    return o;
  };

  const loadsObj = {};
  for (let i = 0; i < 8; i++) loadsObj[FINGER_ORDER[i]] = loads[i];

  return {
    valid: true,
    cost,
    topRatio,
    effort,
    orderPen,
    sfbRate,
    flowUni,
    flowBi,
    uni: rates(uniCnt, flowUniTot),
    bi: rates(biCnt, flowBiTot),
    loads: loadsObj,
  };
}
