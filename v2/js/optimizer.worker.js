// ブラウザ最適化ワーカー: 行列と単打を焼きなまし(SA)で最適化する。
// ユーザーが編集した状態から続行でき、途中経過をリアルタイムに送出する。
//
// メッセージ(main → worker):
//   { type:"start", layout, ngram, weights }  最適化開始
//   { type:"stop" }                           停止
//   { type:"update", layout?, weights? }      現在状態/重みを差し替えて続行
// メッセージ(worker → main):
//   { type:"progress", layout, metrics, iter } 途中経過(現在の最良)

import { MAT_SLOTS, SINGLE_KEYS, cloneLayout, buildMoraKeys } from "./layout.js";
import { computeMetrics, suggestPlacements } from "./metrics.js";

let ngram = null;
let weights = null;
let cur = null;       // 現在のレイアウト
let curCost = Infinity;
let best = null;      // これまでの最良
let bestMetrics = null;
let running = false;
let iter = 0;
let lockSingle = false; // 単打キー(F/J/K)を固定して最適化で動かさない
let maxFreq = 1;        // 行列上のかなの最大頻度(重み付き選択の正規化用)

// polish(貪欲局所探索)用の状態。
let polishMoras = [];   // polish 中に循環する配置済みモーラ(不変)
let polishCursor = 0;
let polishNoImprove = 0;

// SA パラメータ
const T0 = 0.015;
const TMIN = 0.0004;
const COOL = 0.99997;
let temp = T0;
let sinceImprove = 0;

let rngState = 0x2545f491 >>> 0;
function rand() {
  // xorshift32
  let x = rngState;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  rngState = x >>> 0;
  return rngState / 4294967296;
}
function randInt(n) { return (rand() * n) | 0; }

function evalCost(layout) {
  const m = computeMetrics(layout, ngram, weights);
  return { cost: m.cost, metrics: m };
}

function adopt(layout) {
  cur = cloneLayout(layout);
  const r = evalCost(cur);
  curCost = r.cost;
  best = cloneLayout(cur);
  bestMetrics = r.metrics;
  temp = T0;
  sinceImprove = 0;
  // 行列上のかなの最大頻度を求める(棄却サンプリングの正規化に使う)。
  maxFreq = 1;
  for (const s of MAT_SLOTS) {
    const k = cur.mat[s];
    if (k) {
      const f = ngram.unigram[k] || 0;
      if (f > maxFreq) maxFreq = f;
    }
  }
}

// 使用頻度に比例した確率でスロットを選ぶ(棄却サンプリング)。
// 空き・低頻度スロットばかり選んで「効かない試行」になるのを防ぐ。
function pickWeightedSlot() {
  for (let tries = 0; tries < 24; tries++) {
    const i = randInt(MAT_SLOTS.length);
    const k = cur.mat[MAT_SLOTS[i]];
    const f = k ? (ngram.unigram[k] || 0) : 0;
    if (f <= 0) continue;               // 空きは起点に選ばない
    if (rand() < f / maxFreq) return i; // 高頻度ほど採用されやすい
  }
  return randInt(MAT_SLOTS.length);     // フォールバック(一様)
}

function step() {
  // 単打が非固定なら 5% で単打スワップ、それ以外は行列スワップ。
  if (!lockSingle && rand() < 0.05) {
    const a = randInt(SINGLE_KEYS.length);
    let b = randInt(SINGLE_KEYS.length);
    if (a === b) return;
    const ka = SINGLE_KEYS[a], kb = SINGLE_KEYS[b];
    swapSingle(ka, kb);
    const r = evalCost(cur);
    if (accept(r.cost)) { curCost = r.cost; maybeBest(r.metrics); }
    else swapSingle(ka, kb);
  } else {
    // 少なくとも片方は使用頻度で重み付けして選ぶ(効く試行の割合を上げる)。
    // 残り15%は一様選択で低頻度かなの微調整も許す。
    const a = rand() < 0.85 ? pickWeightedSlot() : randInt(MAT_SLOTS.length);
    const b = randInt(MAT_SLOTS.length);
    if (a === b) return;
    const sa = MAT_SLOTS[a], sb = MAT_SLOTS[b];
    if (cur.mat[sa] === cur.mat[sb]) return;
    swapMat(sa, sb);
    const r = evalCost(cur);
    if (accept(r.cost)) { curCost = r.cost; maybeBest(r.metrics); }
    else swapMat(sa, sb);
  }
}

function swapMat(sa, sb) {
  const t = cur.mat[sa]; cur.mat[sa] = cur.mat[sb]; cur.mat[sb] = t;
}
function swapSingle(ka, kb) {
  const t = cur.single[ka]; cur.single[ka] = cur.single[kb]; cur.single[kb] = t;
}

function accept(newCost) {
  if (newCost <= curCost) return true;
  const p = Math.exp(-(newCost - curCost) / Math.max(temp, 1e-9));
  return rand() < p;
}

function maybeBest(metrics) {
  if (metrics.cost < (bestMetrics ? bestMetrics.cost : Infinity)) {
    best = cloneLayout(cur);
    bestMetrics = metrics;
    sinceImprove = 0;
  } else {
    sinceImprove++;
  }
}

function loop() {
  if (!running) {
    postProgress(true);
    self.postMessage({ type: "stopped", iter });
    return;
  }
  const BATCH = 4000;
  for (let i = 0; i < BATCH; i++) {
    step();
    iter++;
    temp = Math.max(TMIN, temp * COOL);
    // 停滞したら再加熱して局所解を脱出。
    if (sinceImprove > 20000) { temp = T0; sinceImprove = 0; }
  }
  postProgress();
  setTimeout(loop, 0); // イベントループに戻して stop/update を受け取れるようにする。
}

let lastPost = 0;
function postProgress(force) {
  if (!best || !bestMetrics) return;
  const now = Date.now();
  if (!force && now - lastPost < 100) return; // ~10fps に間引く
  lastPost = now;
  self.postMessage({
    type: "progress",
    layout: best,
    metrics: bestMetrics,
    iter,
  });
}

// polish: 配置済みモーラを巡回し、各モーラの最良スワップ(差分計算)を適用して
// 2-opt 局所最適まで詰める。行列内の入替のみ(単打は動かさない)。
function polishStep() {
  if (!running) {
    postProgress(true);
    self.postMessage({ type: "stopped", iter });
    return;
  }
  const PER_STEP = 3; // 1回のイベントループで数モーラ処理してテンポを上げる。
  for (let n = 0; n < PER_STEP; n++) {
    if (polishMoras.length === 0 || polishNoImprove >= polishMoras.length) {
      running = false;
      postProgress(true);
      self.postMessage({ type: "stopped", iter });
      return;
    }
    const mora = polishMoras[polishCursor % polishMoras.length];
    polishCursor++;
    // 現在のスロットを探す(スワップで移動するため毎回検索)。
    let slot = null;
    for (const s of MAT_SLOTS) if (cur.mat[s] === mora) { slot = s; break; }
    if (!slot) { polishNoImprove++; continue; }

    const moraKeys = buildMoraKeys(cur);
    const candidates = [];
    for (const s of MAT_SLOTS) {
      if (s === slot) continue;
      const occ = cur.mat[s];
      if (occ === mora) continue;
      candidates.push({ slot: s, occ });
    }
    const { results } = suggestPlacements(ngram, weights, moraKeys, mora, slot, candidates, 1);
    const b0 = results[0];
    if (b0 && b0.delta < -1e-9) {
      swapMat(slot, b0.slot);
      iter++;
      polishNoImprove = 0;
      const r = evalCost(cur);
      curCost = r.cost;
      best = cloneLayout(cur);
      bestMetrics = r.metrics;
    } else {
      polishNoImprove++;
    }
  }
  postProgress();
  setTimeout(polishStep, 0);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "start") {
    ngram = msg.ngram;
    weights = msg.weights;
    lockSingle = !!msg.lockSingle;
    adopt(msg.layout);
    iter = 0;
    if (!running) { running = true; loop(); }
    postProgress(true);
  } else if (msg.type === "polish") {
    ngram = msg.ngram;
    weights = msg.weights;
    lockSingle = !!msg.lockSingle;
    adopt(msg.layout);
    iter = 0;
    // 配置済みモーラ(polish 中は不変)を巡回対象に。
    polishMoras = [];
    for (const s of MAT_SLOTS) if (cur.mat[s]) polishMoras.push(cur.mat[s]);
    polishCursor = 0;
    polishNoImprove = 0;
    if (!running) { running = true; polishStep(); }
    postProgress(true);
  } else if (msg.type === "stop") {
    running = false;
  } else if (msg.type === "update") {
    if (msg.weights) weights = msg.weights;
    if ("lockSingle" in msg) lockSingle = !!msg.lockSingle;
    if (msg.layout) {
      adopt(msg.layout);
    } else if (cur) {
      // 重みだけ変わった場合、現状態を再評価。
      const r = evalCost(cur);
      curCost = r.cost;
      best = cloneLayout(cur);
      bestMetrics = r.metrics;
    }
    postProgress(true);
  }
};
