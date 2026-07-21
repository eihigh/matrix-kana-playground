// optimize.py の fitness() をブラウザへ移植した指標計算。
// 連接評価は index/pinky/middle redirect と roll、repeat/alt/sfb に分類する。
// SFB と SFS は距離重み付きの加算ペナルティとして flow に統合する。
//
// コストの正規化は「質と量の分離」:
//   effort  = Σkey_effort×打鍵数 / モーラ数(作業量。打鍵数の増減はここに現れる)
//   flow    = flowSum / 連接数(1連接あたりの質=滑らかさ。連接の本数に依存しない)
//   strokes = 打鍵数 / モーラ数(w_strokes で打鍵数削減の価値を明示的に調整)
// flow をモーラあたりにすると「連接を消す」ことが「連接を良くする」ことより
// 過大評価される(alt が全連接への基礎税になる)ため、質は連接あたりで測る。
// 差分計算(suggestPlacements)は行列内の入替のみを扱い、キー列長が変わらないので
// 分母(モーラ数・連接数)はどちらも不変のまま成立する。

import {
  FINGER_ORDER, FID, SECOND_KEYS, KEYMAP, classifyPair, buildMoraKeys, keyDist,
} from "./layout.js";

// flow内訳の分類種別。redirectはrollと同時発生し、SFSは別途距離重み付きで集計する。
// redirect は3分類: index(人差し指ホーム/下段を含む) / pinky(小指が絡む) / middle(それ以外)。
export const FLOW_CATS = ["indexRedirect", "pinkyRedirect", "middleRedirect", "goodRoll", "badRoll", "alt", "repeat", "sfb"];

// 既定の重み(optimize.py CONFIG に対応。連接は pen_flow へ統合)。
export function defaultWeights() {
  return {
    w_effort: 1.0,
    w_order: 0.0,
    w_flow: 1.3,      // 連接分類と距離重み付きSFB/SFSをまとめた重み
    w_strokes: 0.0,   // 打鍵数/モーラへの追加ペナルティ(key_effort+altが織り込む分を超えて調整する補助ノブ)
    key_effort: {
      Q: 3.0, W: 1.45, E: 1.24, R: 1.15,
      A: 1.27, S: 1.15, D: 0.94, F: 0.85, G: 1.15, V: 1.15,
      U: 1.15, I: 1.15, O: 1.45, P: 3.0,
      H: 1.15, J: 0.85, K: 0.85, L: 1.15, ";": 1.27, M: 1.15,
    },
    // 連接ペナルティ。good/bad redirect/roll はそれぞれ独立に調整できる。
    pen_flow: {
      indexRedirect: 1.1,
      pinkyRedirect: 1.5,
      middleRedirect: 1.5,
      goodRoll: 0.0,
      badRoll: 1.5,
      alt: 0.8,
      repeat: 3.0,
      sfb: 5.0,
      sfs: 1.5,
    },
  };
}

// 同手ロールの方向。内側=+1 / 外側=-1。
// ロール(同手・別指)は必ず x が異なるので 0 は返らない。
function rollDir(a, b) {
  const A = KEYMAP[a], B = KEYMAP[b];
  const inward = A.hand === "L" ? B.x > A.x : B.x < A.x;
  return inward ? 1 : -1;
}

const GOOD_ROLL_PAIRS = new Set([
  "HI:HM", "HI:HR", "HI:HP", "HI:TM", "HI:TR",
  "HM:HR", "HM:HP", "BI:HM",
  "HR:HP", "BI:HR", "HR:TM",
  "BI:HP", "HP:TM", "HP:TR",
].map((pair) => pair.split(":").sort().join(":")));

function fingerKind(km) { return km.finger[1]; }
function positionKind(km) {
  const row = km.row === "home" ? "H" : (km.row === "top" ? "T" : "B");
  return row + fingerKind(km);
}
function isIndex(km) { return fingerKind(km) === "I"; }

// 長い方の指を伸ばす組み合わせを good roll とする。
// 人差し指内側、および下段人差し指×上段は明示的に bad roll。
export function isGoodRoll(a, b) {
  const ka = KEYMAP[a], kb = KEYMAP[b];
  if (ka.hand !== kb.hand || ka.finger === kb.finger) return false;
  if ((isIndex(ka) && ka.stretch) || (isIndex(kb) && kb.stretch)) return false;
  if ((isIndex(ka) && ka.row === "bottom" && kb.row === "top") ||
      (isIndex(kb) && kb.row === "bottom" && ka.row === "top")) return false;
  if (ka.row === "top" && kb.row === "top") return true;
  return GOOD_ROLL_PAIRS.has([positionKind(ka), positionKind(kb)].sort().join(":"));
}

function isRedirectKey(k) {
  const km = KEYMAP[k];
  return isIndex(km) && !km.stretch && (km.row === "home" || km.row === "bottom");
}

export function isGoodRedirect(a, b, c) {
  return isRedirectKey(a) || isRedirectKey(b) || isRedirectKey(c);
}

// redirect の3分類: 人差し指ホーム/下段を含めば index、
// それ以外で小指が絡めば pinky、どちらでもなければ middle。
export function redirectCategory(a, b, c) {
  if (isGoodRedirect(a, b, c)) return "indexRedirect";
  for (const k of [a, b, c]) {
    if (fingerKind(KEYMAP[k]) === "P") return "pinkyRedirect";
  }
  return "middleRedirect";
}

// 生の集計器(rate 化する前の和)。
function newAcc() {
  return {
    finger: new Array(8).fill(0),
    key: Object.fromEntries(SECOND_KEYS.map((key) => [key, 0])),
    total: 0,
    mora: 0, // 第2モーラの総数(配置に依存しない不変量。モーラあたり正規化の分母)
    totalBg: 0, sfb: 0, sfs: 0, flowSum: 0,
    cnt: {
      indexRedirect: 0, pinkyRedirect: 0, middleRedirect: 0,
      goodRoll: 0, badRoll: 0,
      alt: 0, repeat: 0, sfb: 0,
    },
  };
}

function cloneAcc(a) {
  return {
    finger: a.finger.slice(),
    key: { ...a.key },
    total: a.total,
    mora: a.mora,
    totalBg: a.totalBg, sfb: a.sfb, sfs: a.sfs, flowSum: a.flowSum,
    cnt: { ...a.cnt },
  };
}

// 1つの bigram (m1,m2,freq) の寄与を acc に sign(+1/-1)で加減算する。
// per-key 指標は第2モーラ(k2)のみ、連接は境界ペア+ m2内部ペアのみ計上。
// bikeyのroll等とtrikeyのredirectは別集計で、同じ連接に両方成立すれば両方加算する。
function accumBigram(acc, k1, k2, freq, pf, sign) {
  const f = sign * freq;
  acc.mora += f;
  for (const k of k2) {
    const km = KEYMAP[k];
    acc.total += f;
    acc.key[k] += f;
    acc.finger[FID[km.finger]] += f;
  }

  const run = k1.concat(k2);
  const L1 = k1.length;
  let curDir = 0; // 直前の連接が roll のときだけ方向を保持
  for (let i = 0; i < run.length - 1; i++) {
    const a = run[i], b = run[i + 1];
    const t = classifyPair(a, b);
    const owned = i >= L1 - 1; // 境界ペア(i=L1-1)と m2内部ペア(i>=L1)のみ計上

    let cat, redirectCat = null, pen = 0;
    if (t === "repeat") {
      cat = "repeat"; pen = pf.repeat; curDir = 0;
    } else if (t === "sfb") {
      cat = "sfb"; curDir = 0;
    } else if (t === "alt") {
      cat = "alt"; pen = pf.alt; curDir = 0;  // 方向リセット
    } else { // roll
      const d = rollDir(a, b);
      cat = isGoodRoll(a, b) ? "goodRoll" : "badRoll";
      pen = pf[cat];
      if (curDir !== 0 && d === -curDir) {
        redirectCat = redirectCategory(run[i - 1], a, b);
        pen += pf[redirectCat];
      }
      curDir = d;
    }

    if (owned) {
      acc.totalBg += f;
      acc.cnt[cat] += f;
      if (redirectCat) acc.cnt[redirectCat] += f;
      if (t === "sfb") {
        const distance = keyDist(a, b);
        acc.sfb += f * distance;
        acc.flowSum += f * distance * pf.sfb;
      } else {
        acc.flowSum += f * pen;
      }
    }
  }

  // same-finger skipgram(1キー飛ばし)。距離1以上を距離重み付きで計上。
  // m1≤キーなので skip の2番目は必ず m2 内(=第2モーラ所有)となり二重カウントしない。
  for (let i = 0; i + 2 < run.length; i++) {
    const a = run[i], c = run[i + 2];
    if (KEYMAP[a].finger === KEYMAP[c].finger) {
      const d = keyDist(a, c);
      if (d >= 1) {
        acc.sfs += f * d;
        acc.flowSum += f * d * pf.sfs;
      }
    }
  }
}

// 集計器から指標一式(cost と内訳)を導出する。
// effort/strokes はモーラあたり(量)、flow と内訳表示(flowRates 等)は連接あたり(質)。
function costFromAcc(acc, w) {
  const { finger, key, total, mora, totalBg, sfb, sfs, flowSum, cnt } = acc;
  if (total <= 0 || totalBg <= 0 || mora <= 0) return { cost: 1e9, valid: false };

  const loads = finger.map((v) => v / total);
  const keyLoads = Object.fromEntries(SECOND_KEYS.map((physicalKey) => [physicalKey, key[physicalKey] / total]));
  const sfbRate = sfb / totalBg;
  const sfsRate = sfs / totalBg;
  const flow = flowSum / totalBg; // 1連接あたりの質(滑らかさ)
  const strokes = total / mora;   // 打鍵数/モーラ(量)

  let effort = 0;
  for (const physicalKey of SECOND_KEYS) effort += w.key_effort[physicalKey] * key[physicalKey];
  effort /= mora;

  const handPen = (p, r, m, idx) => {
    const mi = (m + idx) / 2;
    return Math.max(0, p - r) + Math.max(0, r - mi);
  };
  const orderPen =
    handPen(loads[FID.LP], loads[FID.LR], loads[FID.LM], loads[FID.LI]) +
    handPen(loads[FID.RP], loads[FID.RR], loads[FID.RM], loads[FID.RI]);

  const cost =
    w.w_effort * effort +
    w.w_order * orderPen +
    w.w_flow * flow +
    (w.w_strokes || 0) * strokes;

  const flowRates = {};
  for (const c of FLOW_CATS) flowRates[c] = totalBg > 0 ? (cnt[c] || 0) / totalBg : 0;
  flowRates.sfb = sfbRate;
  flowRates.sfs = sfsRate;

  return {
    valid: true, cost,
    effort, orderPen, sfbRate, flow, strokes,
    flowRates, keyLoads,
    sfsRate,
  };
}

// 弱点分析: sfb / repeat / pinkyRedirect / middleRedirect を引き起こす bigram(バイモーラ)を
// 頻度順にランキングする。accumBigram と同じ「第2モーラ所有」ルールで分類するため、
// 各カテゴリの合計は連接内訳(flowRates)と一致する。
// 戻り値: { sfb: [{m1,m2,keys,freq,rate}], repeat: [...], pinkyRedirect: [...], middleRedirect: [...] }(降順・上位 topN)。
export function collectWeakPoints(ngram, moraKeys, topN = 10) {
  const buckets = {
    sfb: new Map(), repeat: new Map(),
    pinkyRedirect: new Map(), middleRedirect: new Map(),
  };
  let totalBg = 0;
  for (const [m1, m2, freq] of ngram.bigramList) {
    const k1 = moraKeys[m1];
    const k2 = moraKeys[m2];
    if (!k1 || !k2) continue;
    const run = k1.concat(k2);
    const L1 = k1.length;
    let curDir = 0;
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i], b = run[i + 1];
      const t = classifyPair(a, b);
      const owned = i >= L1 - 1;
      if (owned) totalBg += freq;
      let hit = null;
      if (t === "repeat") {
        hit = "repeat"; curDir = 0;
      } else if (t === "sfb") {
        hit = "sfb"; curDir = 0;
      } else if (t === "alt") {
        curDir = 0;
      } else { // roll
        const d = rollDir(a, b);
        if (curDir !== 0 && d === -curDir) {
          const cat = redirectCategory(run[i - 1], a, b);
          if (cat !== "indexRedirect") hit = cat;
        }
        curDir = d;
      }
      if (owned && hit) {
        const bucket = buckets[hit];
        const key = m1 + "\t" + m2;
        bucket.set(key, (bucket.get(key) || 0) + freq);
      }
    }
  }

  const out = {};
  for (const [cat, bucket] of Object.entries(buckets)) {
    out[cat] = [...bucket.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, topN)
      .map(([key, freq]) => {
        const [m1, m2] = key.split("\t");
        return {
          m1, m2,
          keys: moraKeys[m1].join("") + " " + moraKeys[m2].join(""),
          freq,
          rate: totalBg > 0 ? freq / totalBg : 0,
        };
      });
  }
  return out;
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
    accumBigram(acc, k1, k2, freq, pf, 1);
  }
  return costFromAcc(acc, w);
}

// 配置サジェスト: 選択かな mora(現在 curSlot)を各候補スロットへ置いた場合の総コストを
// 差分計算で高速に評価する。候補 = [{slot, occ}](occ は空文字なら空きスロット)。
// mora/occ に触れる bigram だけを再計算し(全 6187 件のうちごく一部)、ベースから差分で更新する。
// total/totalBg/mora は行列内の入替・移動では不変なため差分計算が成立する。
// tweakThreshold: ΔCost がこの値未満のスロットを「微調整可能(ほぼ無コストで動かせる)」として返す。
// unitsOf(mora): 拗音分解モード用。モーラを構成する「配置単位かな」の配列を返す
// (例 しゃ→[し,ゃ])。null/未指定ならモーラ自身が単位。単位かなの移動が
// それを含む合成モーラの bigram にも波及するよう、索引とキー再導出を単位ベースで行う。
// 戻り値: { baseCost, results: [{slot, occ, cost, delta}](昇順・上位 topN), tweak: [slot,...] }。
export function suggestPlacements(ngram, weights, moraKeys, mora, curSlot, candidates, topN = 6, tweakThreshold = 0.0005, unitsOf = null) {
  const w = weights;
  const pf = w.pen_flow;
  const unitList = (m) => (unitsOf && unitsOf(m)) || [m];

  // 単位索引: 単位かな -> それを(構成要素として)含む bigram エントリ配列。
  const index = new Map();
  for (const e of ngram.bigramList) {
    const units = new Set([...unitList(e[0]), ...unitList(e[1])]);
    for (const u of units) {
      let a = index.get(u); if (!a) index.set(u, a = []);
      a.push(e);
    }
  }

  // ベース集計とコスト。
  const base = newAcc();
  for (const [m1, m2, freq] of ngram.bigramList) {
    const k1 = moraKeys[m1];
    const k2 = moraKeys[m2];
    if (!k1 || !k2) continue;
    accumBigram(base, k1, k2, freq, pf, 1);
  }
  const baseCost = costFromAcc(base, w).cost;

  // 新配置でのモーラのキー列: 単位かなのキーを overrides で差し替えて連結する。
  // 単位が1つでも未配置(null)なら null(そのモーラは打てない)。
  const keysWith = (m, overrides) => {
    const units = unitList(m);
    if (units.length === 1) {
      const u = units[0];
      return u in overrides ? overrides[u] : moraKeys[m];
    }
    const parts = units.map((u) => (u in overrides ? overrides[u] : moraKeys[u]));
    if (parts.some((p) => !p)) return null;
    return parts.flat();
  };

  const curKeys = [curSlot[0], curSlot.slice(1)];
  const affectedA = index.get(mora) || [];
  const results = [];

  for (const { slot, occ } of candidates) {
    const slotKeys = [slot[0], slot.slice(1)];
    // 差分対象 = mora と occ に(構成要素として)触れる bigram(重複排除)。
    const affected = occ ? new Set(affectedA) : affectedA;
    if (occ) for (const e of (index.get(occ) || [])) affected.add(e);

    const overrides = occ ? { [mora]: slotKeys, [occ]: curKeys } : { [mora]: slotKeys };
    const acc = cloneAcc(base);
    for (const e of affected) {
      const [m1, m2, freq] = e;
      const ok1 = moraKeys[m1], ok2 = moraKeys[m2];
      if (ok1 && ok2) accumBigram(acc, ok1, ok2, freq, pf, -1); // 旧配置を除去
      const nk1 = keysWith(m1, overrides);
      const nk2 = keysWith(m2, overrides);
      if (nk1 && nk2) accumBigram(acc, nk1, nk2, freq, pf, 1);   // 新配置を加算
    }
    const cost = costFromAcc(acc, w).cost;
    results.push({ slot, occ, cost, delta: cost - baseCost });
  }

  results.sort((a, b) => a.cost - b.cost);
  const tweak = [];
  for (const r of results) if (r.delta < tweakThreshold) tweak.push(r.slot);
  return { baseCost, results: results.slice(0, topN), tweak };
}

// 例示用: モーラ列を現在の配置で連続キー列に展開し、三連接ルールで
// 各連接を分類する(コスト計算ではなく、分類ラベルの可視化用)。
// 例文は1連続ストリームとして扱う(第2モーラ所有の近似ではなく実ストリームを分類)。
// 戻り値: { keys: [{mora, key, moraStart}], steps: [{cat,cats}] }(steps は keys 間の連接)。
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
    if (!a || !b) { steps.push({ cat: "none", cats: ["none"] }); curDir = 0; continue; }
    const t = classifyPair(a, b);
    let cat, redirectCat = null;
    if (t === "repeat") {
      cat = "repeat"; curDir = 0;
    } else if (t === "sfb") {
      cat = "sfb"; curDir = 0;
    } else if (t === "alt") {
      cat = "alt"; curDir = 0;                // 方向リセット
    } else {
      const d = rollDir(a, b);
      cat = isGoodRoll(a, b) ? "goodRoll" : "badRoll";
      if (curDir !== 0 && d === -curDir) {
        redirectCat = redirectCategory(keys[i - 1].key, a, b);
      }
      curDir = d;
    }
    steps.push({ cat, cats: redirectCat ? [cat, redirectCat] : [cat] });
  }

  // SFS はbikey/redirect分類と同時に成立する。3キー目へ到達する連接に併記する。
  for (let i = 0; i + 2 < keys.length; i++) {
    const a = keys[i].key, c = keys[i + 2].key;
    if (!a || !c) continue;
    if (KEYMAP[a].finger === KEYMAP[c].finger && keyDist(a, c) >= 1) {
      steps[i + 1].cats.push("sfs");
    }
  }
  return { keys, steps };
}
