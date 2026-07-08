// optimize.py の fitness() をブラウザへ移植した指標計算。
// 連接評価は「方向つきロール状態機械」に統合(pen_flow)。
// SFB は距離重み(w_sfb)で別計上し、連接では最大減点扱い。

import {
  FINGER_ORDER, FID, KEYMAP, classifyPair, buildMoraKeys, keyDist,
} from "./layout.js";

// 連接評価の種別(表示・内訳の順序)。sfb は別枠(w_sfb)で減点する。
export const FLOW_CATS = ["inroll", "outroll", "redirect", "alt", "repeat", "sfb"];

// 既定の重み(optimize.py CONFIG に対応。連接は pen_flow へ統合)。
export function defaultWeights() {
  return {
    w_top: 1.0,
    w_index_stretch: 0.2,  // 人差し内側stretch率(G/H の打鍵。R/U は topRatio 側で計上)
    w_index_bottom: 0.05,  // 人差し下段率(V/M の打鍵)
    w_effort: 1.0,
    w_order: 0.0,
    w_sfb: 3.0,       // SFB は距離重み付き(keyDist)で計上。連接では最大減点扱い。
    w_skip: 0.5,      // 同指スキップグラム(1キー飛ばし)のうち非隣接=人差し指の大移動のみ。距離重み。
    w_vbounce: 0.2,   // ロール逸脱(同手ロールでホームを離れる分を roll_move で計上)
    w_flow: 1.0,      // 連接(方向つきロール状態機械)の重み
    finger_effort: {
      LP: 1.8, LR: 1.7, LM: 1.3, LI: 1.0,
      RI: 1.0, RM: 1.0, RR: 1.7, RP: 1.8,
    },
    // vbounce 用: 指がホームを離れて縦/内へ動く負担(逸脱重み)。
    // 非人差し指は逸脱先が上段のみなので指ごとに1値。
    // 人差し指だけ上段/内側stretch/下段の3方向に逸脱するので方向別に分ける
    // (下段は自然で軽く、上段への伸びは重い、など直接調整できる)。
    roll_move: {
      LP: 3.2, LR: 2.9, LM: 2.05,
      RM: 2.0, RR: 2.5, RP: 2.8,
      LI_top: 1.4, LI_stretch: 1.0, LI_bottom: 0.6,
      RI_top: 1.4, RI_stretch: 1.0, RI_bottom: 0.6,
    },
    // 連接の統合ペナルティ(方向つきロール状態機械)。
    //   inroll/outroll = 同方向ロール(最良)。方向は x軸のみ、段跨ぎは vbounce が担当。
    //   redirect       = 同手で方向反転(大幅減点)。
    //   alt            = 逆手(小減点+方向リセット)。
    //   repeat         = 同キー連打(小減点+方向維持)。
    //   sfb は別枠(w_sfb)なので pen_flow には持たない(方向維持)。
    //   inroll/outroll は区別しない想定だが、調整用に別パラメータで用意(既定は同値)。
    pen_flow: {
      inroll: 0.0,
      outroll: 0.0,
      redirect: 2.0,
      alt: 0.5,
      repeat: 0.5,
    },
    // はさみ(scissor): 中指上段×人差し下段の同手連続は逆方向に指が開くので加算。
    // これはペアの組み合わせ罰なので roll_move(単キーの逸脱重み)とは別枠。
    vb_scissor: 3.0,
  };
}

// 同手ロールの方向。内側=+1 / 外側=-1(x軸のみ。段跨ぎは vbounce が担当)。
// ロール(同手・別指)は必ず x が異なるので 0 は返らない。
function rollDir(a, b) {
  const A = KEYMAP[a], B = KEYMAP[b];
  const inward = A.hand === "L" ? B.x > A.x : B.x < A.x;
  return inward ? 1 : -1;
}

// layout = { mat, single }, ngram = { bigramList }, weights。
// 指標一式(cost と内訳)を返す。
// moraKeys を渡すと buildMoraKeys を省略する(サジェスト等の連続評価の高速化用)。
//
// ホームキーを離れる分(top/bottom/内側stretch)を逸脱重み roll_move で評価。vbounce の対象。
// 非人差し指は上段のみなので roll_move[finger]。人差し指は方向別(上段/stretch/下段)。
function vmoveOf(k, w) {
  const km = KEYMAP[k];
  if (km.row === "home" && !km.stretch) return 0;
  const rm = w.roll_move;
  if (km.finger === "LI" || km.finger === "RI") {
    const dir = km.stretch ? "_stretch" : (km.row === "top" ? "_top" : "_bottom");
    return rm[km.finger + dir];
  }
  return rm[km.finger]; // 非人差し指の逸脱先は上段のみ。
}

// はさみ(scissor)判定用: 中指上段 / 人差し下段。
function isMidTop(km) { return km.row === "top" && (km.finger === "LM" || km.finger === "RM"); }
function isIndexBottom(km) { return km.row === "bottom" && (km.finger === "LI" || km.finger === "RI"); }

// 逸脱スタッツの種別(スライダー並びに一致)。scissor はペア罰。
export const DEV_CATS = [
  "LP", "LR", "LM", "LI_top", "LI_stretch", "LI_bottom",
  "RI_top", "RI_stretch", "RI_bottom", "RM", "RR", "RP", "scissor",
];

// キー→逸脱スタッツ種別(ホームキーは null)。roll_move のキーと一致する。
function devCat(km) {
  if (km.row === "home" && !km.stretch) return null;
  if (km.finger === "LI" || km.finger === "RI") {
    return km.finger + (km.stretch ? "_stretch" : (km.row === "top" ? "_top" : "_bottom"));
  }
  return km.finger;
}

function newDev() {
  const d = {};
  for (const c of DEV_CATS) d[c] = 0;
  return d;
}

// 生の集計器(rate 化する前の和)。
function newAcc() {
  return {
    finger: new Array(8).fill(0),
    total: 0, top: 0, indexStretch: 0, indexBottom: 0,
    totalBg: 0, sfb: 0, skip: 0, vbounce: 0, flowSum: 0,
    cnt: { inroll: 0, outroll: 0, redirect: 0, alt: 0, repeat: 0, sfb: 0 },
    dev: newDev(),
  };
}

function cloneAcc(a) {
  return {
    finger: a.finger.slice(),
    total: a.total, top: a.top, indexStretch: a.indexStretch, indexBottom: a.indexBottom,
    totalBg: a.totalBg, sfb: a.sfb, skip: a.skip, vbounce: a.vbounce, flowSum: a.flowSum,
    cnt: { ...a.cnt },
    dev: { ...a.dev },
  };
}

// 1つの bigram (m1,m2,freq) の寄与を acc に sign(+1/-1)で加減算する。
// per-key 指標は第2モーラ(k2)のみ、連接は境界ペア+ m2内部ペアのみ計上。
function accumBigram(acc, k1, k2, freq, w, pf, sign) {
  const f = sign * freq;
  for (const k of k2) {
    const km = KEYMAP[k];
    acc.total += f;
    if (km.row === "top") acc.top += f;
    if (km.stretch) acc.indexStretch += f;
    if (km.row === "bottom") acc.indexBottom += f;
    acc.finger[FID[km.finger]] += f;
  }

  const run = k1.concat(k2);
  const L1 = k1.length;
  let curDir = 0; // 0 = 未確立
  for (let i = 0; i < run.length - 1; i++) {
    const a = run[i], b = run[i + 1];
    const t = classifyPair(a, b);
    const owned = i >= L1 - 1; // 境界ペア(i=L1-1)と m2内部ペア(i>=L1)のみ計上

    let cat, pen = 0;
    if (t === "repeat") {
      cat = "repeat"; pen = pf.repeat;       // 方向維持
    } else if (t === "sfb") {
      cat = "sfb";                            // 別枠(w_sfb)。方向維持
    } else if (t === "alt") {
      cat = "alt"; pen = pf.alt; curDir = 0;  // 方向リセット
    } else { // roll
      const d = rollDir(a, b);
      if (curDir !== 0 && d === -curDir) {
        cat = "redirect"; pen = pf.redirect;  // 方向反転
      } else {
        cat = d > 0 ? "inroll" : "outroll";
        pen = d > 0 ? pf.inroll : pf.outroll;
      }
      curDir = d;
    }

    if (owned) {
      acc.totalBg += f;
      acc.cnt[cat] += f;
      if (t === "sfb") acc.sfb += f * keyDist(a, b);
      else acc.flowSum += f * pen;
      if (t === "roll") {
        let vb = vmoveOf(a, w) + vmoveOf(b, w);
        // 中指上段×人差し下段の同手連続(はさみ)は逆方向開きで加算。
        const ka = KEYMAP[a], kb = KEYMAP[b];
        const scissor = (isMidTop(ka) && isIndexBottom(kb)) || (isMidTop(kb) && isIndexBottom(ka));
        if (scissor) vb += w.vb_scissor;
        acc.vbounce += f * vb;
        // 逸脱スタッツ(種別ごとの出現頻度)。
        const ca = devCat(ka); if (ca) acc.dev[ca] += f;
        const cb = devCat(kb); if (cb) acc.dev[cb] += f;
        if (scissor) acc.dev.scissor += f;
      }
    }
  }

  // same-finger skipgram(1キー飛ばし)。非隣接(同指で keyDist>1)のみ計上。
  // 非人差し指は同指が上段+ホームの隣接(dist=1)のみなので、この条件は
  // 実質人差し指の大移動(R↔V, R↔G, G↔V, U↔M 等)だけを拾う。
  // m1≤キーなので skip の2番目は必ず m2 内(=第2モーラ所有)となり二重カウントしない。
  for (let i = 0; i + 2 < run.length; i++) {
    const a = run[i], c = run[i + 2];
    if (KEYMAP[a].finger === KEYMAP[c].finger) {
      const d = keyDist(a, c);
      if (d > 1) acc.skip += f * d;
    }
  }
}

// 集計器から指標一式(cost と内訳)を導出する。総和(total/totalBg)を分母に rate 化。
function costFromAcc(acc, w) {
  const { finger, total, top, indexStretch, indexBottom, totalBg, sfb, skip, vbounce, flowSum, cnt } = acc;
  if (total <= 0 || totalBg <= 0) return { cost: 1e9, valid: false };

  const loads = finger.map((v) => v / total);
  const topRatio = top / total;
  const indexStretchRate = indexStretch / total;
  const indexBottomRate = indexBottom / total;
  const sfbRate = sfb / totalBg;
  const skipRate = skip / totalBg;
  const vbounceRate = vbounce / totalBg;
  const flow = flowSum / totalBg;

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

  const cost =
    w.w_top * topRatio +
    w.w_index_stretch * indexStretchRate +
    w.w_index_bottom * indexBottomRate +
    w.w_effort * effort +
    w.w_order * orderPen +
    w.w_sfb * sfbRate +
    w.w_skip * skipRate +
    w.w_vbounce * vbounceRate +
    w.w_flow * flow;

  const flowRates = {};
  for (const c of FLOW_CATS) flowRates[c] = totalBg > 0 ? (cnt[c] || 0) / totalBg : 0;

  const loadsObj = {};
  for (let i = 0; i < 8; i++) loadsObj[FINGER_ORDER[i]] = loads[i];

  const devRates = {};
  for (const c of DEV_CATS) devRates[c] = totalBg > 0 ? (acc.dev[c] || 0) / totalBg : 0;

  return {
    valid: true, cost,
    topRatio, indexStretchRate, indexBottomRate,
    effort, orderPen, sfbRate, vbounceRate, flow,
    flowRates, loads: loadsObj,
    skipRate, devRates,
  };
}

// すべて bigram 駆動。各連接のキー列 keys(m1)++keys(m2)(2〜4キー)を1パスで評価し、
// 「第2モーラ側」(境界ペア + m2内部ペア)だけを計上する(二重カウント防止)。
// 第1モーラ内部ペアは方向状態の文脈参照のみで計上しない。
// 静的な per-key 指標も第2モーラの打鍵のみ計上する(総和は unigram に ≈ 一致)。
// moraKeys を渡すと buildMoraKeys を省略する(連続評価の高速化用)。
export function computeMetrics(layout, ngram, weights, moraKeys) {
  const w = weights;
  const pf = w.pen_flow;
  if (!moraKeys) moraKeys = buildMoraKeys(layout);

  const acc = newAcc();
  for (const [m1, m2, freq] of ngram.bigramList) {
    const k1 = moraKeys[m1];
    const k2 = moraKeys[m2];
    if (!k1 || !k2) continue;
    accumBigram(acc, k1, k2, freq, w, pf, 1);
  }
  return costFromAcc(acc, w);
}

// 配置サジェスト: 選択かな mora(現在 curSlot)を各候補スロットへ置いた場合の総コストを
// 差分計算で高速に評価する。候補 = [{slot, occ}](occ は空文字なら空きスロット)。
// mora/occ に触れる bigram だけを再計算し(全 6187 件のうちごく一部)、ベースから差分で更新する。
// total/totalBg は行列内の入替・移動では不変なため差分計算が成立する。
// tweakThreshold: ΔCost がこの値未満のスロットを「微調整可能(ほぼ無コストで動かせる)」として返す。
// 戻り値: { baseCost, results: [{slot, occ, cost, delta}](昇順・上位 topN), tweak: [slot,...] }。
export function suggestPlacements(ngram, weights, moraKeys, mora, curSlot, candidates, topN = 6, tweakThreshold = 0.0005) {
  const w = weights;
  const pf = w.pen_flow;

  // モーラ索引: mora -> それを含む bigram エントリ配列。
  const index = new Map();
  for (const e of ngram.bigramList) {
    let a = index.get(e[0]); if (!a) index.set(e[0], a = []); a.push(e);
    if (e[1] !== e[0]) { let b = index.get(e[1]); if (!b) index.set(e[1], b = []); b.push(e); }
  }

  // ベース集計とコスト。
  const base = newAcc();
  for (const [m1, m2, freq] of ngram.bigramList) {
    const k1 = moraKeys[m1];
    const k2 = moraKeys[m2];
    if (!k1 || !k2) continue;
    accumBigram(base, k1, k2, freq, w, pf, 1);
  }
  const baseCost = costFromAcc(base, w).cost;

  const curKeys = [curSlot[0], curSlot.slice(1)];
  const affectedA = index.get(mora) || [];
  const results = [];

  for (const { slot, occ } of candidates) {
    const slotKeys = [slot[0], slot.slice(1)];
    // 差分対象 = mora と occ に触れる bigram(重複排除)。
    const affected = occ ? new Set(affectedA) : affectedA;
    if (occ) for (const e of (index.get(occ) || [])) affected.add(e);

    const acc = cloneAcc(base);
    for (const e of affected) {
      const [m1, m2, freq] = e;
      const ok1 = moraKeys[m1], ok2 = moraKeys[m2];
      if (ok1 && ok2) accumBigram(acc, ok1, ok2, freq, w, pf, -1); // 旧配置を除去
      // 新配置のキー: mora→slotKeys, occ→curKeys, それ以外は現状。
      const nk1 = m1 === mora ? slotKeys : (m1 === occ ? curKeys : ok1);
      const nk2 = m2 === mora ? slotKeys : (m2 === occ ? curKeys : ok2);
      if (nk1 && nk2) accumBigram(acc, nk1, nk2, freq, w, pf, 1);   // 新配置を加算
    }
    const cost = costFromAcc(acc, w).cost;
    results.push({ slot, occ, cost, delta: cost - baseCost });
  }

  results.sort((a, b) => a.cost - b.cost);
  const tweak = [];
  for (const r of results) if (r.delta < tweakThreshold) tweak.push(r.slot);
  return { baseCost, results: results.slice(0, topN), tweak };
}

// 例示用: モーラ列を現在の配置で連続キー列に展開し、方向つきロール状態機械で
// 各連接を分類する(コスト計算ではなく、分類ラベルの可視化用)。
// 例文は1連続ストリームとして扱う(第2モーラ所有の近似ではなく実ストリームを分類)。
// 戻り値: { keys: [{mora, key, moraStart}], steps: [{cat}] }(steps は keys 間の連接)。
export function classifyStream(moras, moraKeys) {
  const keys = [];
  for (const mora of moras) {
    const ks = moraKeys[mora];
    if (!ks || ks.length === 0) {
      keys.push({ mora, key: null, moraStart: true });
      continue;
    }
    ks.forEach((k, i) => keys.push({ mora, key: k, moraStart: i === 0 }));
  }

  const steps = [];
  let curDir = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i].key, b = keys[i + 1].key;
    if (!a || !b) { steps.push({ cat: "none" }); curDir = 0; continue; }
    const t = classifyPair(a, b);
    let cat;
    if (t === "repeat") {
      cat = "repeat";                         // 方向維持
    } else if (t === "sfb") {
      cat = "sfb";                            // 方向維持
    } else if (t === "alt") {
      cat = "alt"; curDir = 0;                // 方向リセット
    } else {
      const d = rollDir(a, b);
      cat = (curDir !== 0 && d === -curDir) ? "redirect" : (d > 0 ? "inroll" : "outroll");
      curDir = d;
    }
    steps.push({ cat });
  }
  return { keys, steps };
}
