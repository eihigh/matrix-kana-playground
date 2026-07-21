// ブラウザ最適化ワーカー: 行列と単打を焼きなまし(SA)で最適化する。
// ユーザーが編集した状態から続行でき、途中経過をリアルタイムに送出する。
//
// メッセージ(main → worker):
//   { type:"start", layout, ngram, weights }  最適化開始
//   { type:"stop" }                           停止
//   { type:"update", layout?, weights? }      現在状態/重みを差し替えて続行
// メッセージ(worker → main):
//   { type:"progress", layout, metrics, iter } 途中経過(現在の最良)

import { SECOND_KEYS, singleKeysOf, firstKeysOf, matSlotsOf, cloneLayout, buildMoraKeys, splitMora } from "./layout.js";
import { computeMetrics, suggestPlacements } from "./metrics.js";

let ngram = null;
let weights = null;
let cur = null;       // 現在のレイアウト
let curCost = Infinity;
let best = null;      // これまでの最良
let bestMetrics = null;
let running = false;
let iter = 0;
let lockSingle = false; // 単打(キー位置と割当)を固定して最適化で動かさない
let yoonSplit = false;  // 拗音分解モード(しゃ=し+ゃ。moraKeys 導出と差分索引に影響)
let maxFreq = 1;        // 行列上のかなの最大頻度(重み付き選択の正規化用)
// 単打キーは自由(位置も割当も move の対象)。現在の単打集合から導出する。
let singleKeys = [];    // 現在の単打キー
let matSlots = [];      // 現在の行列スロット(単打集合に依存)

// polish(貪欲局所探索)用の状態。
let polishMoras = [];   // polish 中に循環する配置済みモーラ(不変)
let polishCursor = 0;
let polishNoImprove = 0;

// SA パラメータ: 温度は開始コスト比で決める(コストのスケールに自動追従)。
// ROUND_ITERS を1ラウンドとして T0→TMIN まで冷却し切り、best から再スタートを繰り返す。
// (固定温度+停滞リヒートだと、正規化変更後のコストスケールでは平衡温度に
//  張り付いて収束しないため、有限ラウンドの完全冷却方式にした。)
const T0_FRAC = 0.01;
const TMIN_FRAC = 0.0001;
const ROUND_ITERS = 30000;
let temp = 0;
let cool = 1;
let roundIter = 0;

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
  const m = computeMetrics(layout, ngram, weights, buildMoraKeys(layout, yoonSplit));
  return { cost: m.cost, metrics: m };
}

// 拗音分解モード時の suggestPlacements 用: モーラ→構成単位かな。
function unitsOf(m) {
  if (!yoonSplit) return null;
  const units = splitMora(m);
  return units.length === 2 ? units : null;
}

// 単打集合の変化(役割スワップ・adopt)後に導出状態を同期する。
function syncDerived() {
  singleKeys = singleKeysOf(cur);
  matSlots = matSlotsOf(singleKeys);
}

// 現在コストから温度スケジュールを張り直す(ラウンド開始)。
function startRound() {
  const t0 = T0_FRAC * curCost;
  temp = t0;
  cool = Math.pow((TMIN_FRAC * curCost) / t0, 1 / ROUND_ITERS);
  roundIter = 0;
}

function adopt(layout) {
  cur = cloneLayout(layout);
  syncDerived();
  const r = evalCost(cur);
  curCost = r.cost;
  best = cloneLayout(cur);
  bestMetrics = r.metrics;
  startRound();
  // 行列上のかなの最大頻度を求める(棄却サンプリングの正規化に使う)。
  maxFreq = 1;
  for (const s of matSlots) {
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
    const i = randInt(matSlots.length);
    const k = cur.mat[matSlots[i]];
    const f = k ? (ngram.unigram[k] || 0) : 0;
    if (f <= 0) continue;               // 空きは起点に選ばない
    if (rand() < f / maxFreq) return i; // 高頻度ほど採用されやすい
  }
  return randInt(matSlots.length);     // フォールバック(一様)
}

function step() {
  // 単打が非固定なら: 4% 単打同士の割当スワップ / 8% 行列⇄単打の割当スワップ /
  // 2% 単打キーの役割スワップ(どのキーが単打かを変える)。残りは行列スワップ。
  const p = (lockSingle || singleKeys.length === 0) ? 1 : rand();
  if (p < 0.04) {
    const a = randInt(singleKeys.length);
    const b = randInt(singleKeys.length);
    if (a === b) return;
    const ka = singleKeys[a], kb = singleKeys[b];
    swapSingle(ka, kb);
    const r = evalCost(cur);
    if (accept(r.cost)) { curCost = r.cost; maybeBest(r.metrics); }
    else swapSingle(ka, kb);
  } else if (p < 0.12) {
    // 行列かな ⇄ 単打かな(どのかなを単打にするか)。単打が空にならないよう
    // 行列側は必ずかな入りスロットを選ぶ。
    const sk = singleKeys[randInt(singleKeys.length)];
    const slot = matSlots[pickWeightedSlot()];
    if (!cur.mat[slot]) return;
    swapCross(slot, sk);
    const r = evalCost(cur);
    if (accept(r.cost)) { curCost = r.cost; maybeBest(r.metrics); }
    else swapCross(slot, sk);
  } else if (p < 0.14) {
    // 単打キーの役割スワップ: 単打キー a と通常キー b を交換。
    // b列(第1キー b のスロット)の中身を a列の同じ第2キーへ写す(全単射・可逆)。
    const a = singleKeys[randInt(singleKeys.length)];
    const firsts = firstKeysOf(singleKeys);
    const b = firsts[randInt(firsts.length)];
    roleSwap(a, b);
    const r = evalCost(cur);
    if (accept(r.cost)) { curCost = r.cost; maybeBest(r.metrics); }
    else roleSwap(b, a);
  } else {
    // 少なくとも片方は使用頻度で重み付けして選ぶ(効く試行の割合を上げる)。
    // 残り15%は一様選択で低頻度かなの微調整も許す。
    const a = rand() < 0.85 ? pickWeightedSlot() : randInt(matSlots.length);
    const b = randInt(matSlots.length);
    if (a === b) return;
    const sa = matSlots[a], sb = matSlots[b];
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
// 行列スロットと単打キーのかなを入れ替える。
function swapCross(slot, singleKey) {
  const t = cur.mat[slot];
  cur.mat[slot] = cur.single[singleKey];
  cur.single[singleKey] = t;
}
// 単打キー a と通常キー b の役割を交換する。b列の中身は a列へ同じ第2キーで写し、
// 単打かなは a→b へ移る。roleSwap(b, a) でちょうど元に戻る。
function roleSwap(a, b) {
  const mat = cur.mat;
  const newMat = {};
  for (const [slot, kana] of Object.entries(mat)) {
    if (slot[0] === b) continue; // b列は除去(下で a列へ写す)
    newMat[slot] = kana;
  }
  for (const s of SECOND_KEYS) {
    newMat[a + s] = mat[b + s] || "";
  }
  cur.mat = newMat;
  cur.single[b] = cur.single[a];
  delete cur.single[a];
  syncDerived();
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
    temp *= cool;
    roundIter++;
    // ラウンド完了: best から次ラウンドを再スタート(温度を張り直す)。
    if (roundIter >= ROUND_ITERS) {
      cur = cloneLayout(best);
      curCost = bestMetrics.cost;
      syncDerived();
      startRound();
    }
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
// 2-opt 局所最適まで詰める。行列が収束したら単打(割当・役割)も全探索で詰め、
// 改善があれば行列巡回へ戻る(lockSingle 時は行列のみ)。
function polishStep() {
  if (!running) {
    postProgress(true);
    self.postMessage({ type: "stopped", iter });
    return;
  }
  const PER_STEP = 3; // 1回のイベントループで数モーラ処理してテンポを上げる。
  for (let n = 0; n < PER_STEP; n++) {
    if (polishMoras.length === 0 || polishNoImprove >= polishMoras.length) {
      // 行列が局所最適に達した。単打側を全探索し、改善したら行列巡回を再開。
      if (!lockSingle && polishSinglesPass()) {
        polishNoImprove = 0;
        continue;
      }
      running = false;
      postProgress(true);
      self.postMessage({ type: "stopped", iter });
      return;
    }
    const mora = polishMoras[polishCursor % polishMoras.length];
    polishCursor++;
    // 現在のスロットを探す(スワップで移動するため毎回検索)。
    let slot = null;
    for (const s of matSlots) if (cur.mat[s] === mora) { slot = s; break; }
    if (!slot) { polishNoImprove++; continue; }

    const moraKeys = buildMoraKeys(cur, yoonSplit);
    const candidates = [];
    for (const s of matSlots) {
      if (s === slot) continue;
      const occ = cur.mat[s];
      if (occ === mora) continue;
      candidates.push({ slot: s, occ });
    }
    const { results } = suggestPlacements(ngram, weights, moraKeys, mora, slot, candidates, 1, 0.0005, unitsOf);
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

// 単打の全探索パス: ①各単打かな⇄各行列かなのスワップ、②単打キーの役割スワップを
// 総当りで評価し、最良の改善を1手適用する。改善があれば true。
function polishSinglesPass() {
  let bestDelta = -1e-9;
  let apply = null;
  for (const sk of [...singleKeys]) {
    // ① 割当スワップ(行列かな⇄単打かな)
    for (const slot of matSlots) {
      if (!cur.mat[slot]) continue;
      swapCross(slot, sk);
      const r = evalCost(cur);
      swapCross(slot, sk);
      const delta = r.cost - curCost;
      if (delta < bestDelta) { bestDelta = delta; apply = { kind: "cross", slot, sk }; }
    }
    // ② 役割スワップ(単打キーの位置替え)
    for (const b of firstKeysOf(singleKeys)) {
      roleSwap(sk, b);
      const r = evalCost(cur);
      roleSwap(b, sk);
      const delta = r.cost - curCost;
      if (delta < bestDelta) { bestDelta = delta; apply = { kind: "role", sk, b }; }
    }
  }
  if (!apply) return false;
  if (apply.kind === "cross") swapCross(apply.slot, apply.sk);
  else roleSwap(apply.sk, apply.b);
  iter++;
  const r = evalCost(cur);
  curCost = r.cost;
  best = cloneLayout(cur);
  bestMetrics = r.metrics;
  // 役割スワップでスロット集合が変わった場合に備えて巡回対象を取り直す。
  polishMoras = [];
  for (const s of matSlots) if (cur.mat[s]) polishMoras.push(cur.mat[s]);
  polishCursor = 0;
  return true;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "start") {
    ngram = msg.ngram;
    weights = msg.weights;
    lockSingle = !!msg.lockSingle;
    yoonSplit = !!msg.yoonSplit;
    adopt(msg.layout);
    iter = 0;
    if (!running) { running = true; loop(); }
    postProgress(true);
  } else if (msg.type === "polish") {
    ngram = msg.ngram;
    weights = msg.weights;
    lockSingle = !!msg.lockSingle;
    yoonSplit = !!msg.yoonSplit;
    adopt(msg.layout);
    iter = 0;
    // 配置済みモーラ(行列巡回中は不変)を巡回対象に。
    polishMoras = [];
    for (const s of matSlots) if (cur.mat[s]) polishMoras.push(cur.mat[s]);
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
