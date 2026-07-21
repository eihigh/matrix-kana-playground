// node --experimental-default-type=module --test v2/js/metrics.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyStream,
  computeMetrics,
  defaultWeights,
  isGoodRedirect,
  isGoodRoll,
  suggestPlacements,
} from "./metrics.js";
import { FIRST_KEYS, MAT_SLOTS, SECOND_KEYS, SINGLE_KEYS, SPLIT_KANA, buildMoraKeys, defaultLayout, splitMora } from "./layout.js";
import { textToMoras } from "./romaji.js";
import { normalizeLayout } from "./storage.js";

function classifyKeys(physicalKeys) {
  const moras = physicalKeys.map((_, index) => String(index));
  const moraKeys = Object.fromEntries(
    physicalKeys.map((key, index) => [String(index), [key]])
  );
  return classifyStream(moras, moraKeys).steps.map((step) => step.cats);
}

function metricsForKeys(keys) {
  return computeMetrics(
    {},
    { bigramList: [["first", "second", 1]] },
    defaultWeights(),
    { first: [keys[0]], second: keys.slice(1) }
  );
}

test("good roll: 仕様に記載された指・段の組み合わせ", () => {
  const cases = [
    ["F", "D", "HI <-> HM"],
    ["F", "E", "HI <-> TM"],
    ["D", "V", "HM <-> BI"],
    ["S", "E", "HR <-> TM"],
    ["A", "E", "HP <-> TM"],
    ["Q", "W", "Top Row同士"],
  ];

  for (const [first, second, description] of cases) {
    assert.equal(isGoodRoll(first, second), true, description);
    assert.equal(isGoodRoll(second, first), true, `${description}（逆方向）`);
  }
});

test("bad roll: 内側人差し指と下段人差し指×上段", () => {
  const cases = [
    ["G", "D", "内側人差し指 G"],
    ["H", "K", "内側人差し指 H"],
    ["V", "E", "下段人差し指 V × 上段 E"],
    ["M", "I", "下段人差し指 M × 上段 I"],
  ];

  for (const [first, second, description] of cases) {
    assert.equal(isGoodRoll(first, second), false, description);
    assert.deepEqual(classifyKeys([first, second]), [["badRoll"]], description);
  }
});

test("redirect: HI/BIを含めばindex、小指が絡めばpinky、それ以外はmiddle", () => {
  assert.equal(isGoodRedirect("A", "F", "D"), true, "HIのFを含む");
  assert.deepEqual(classifyKeys(["A", "F", "D"]), [["goodRoll"], ["goodRoll", "indexRedirect"]]);

  assert.deepEqual(classifyKeys(["Q", "F", "W"]), [["badRoll"], ["goodRoll", "indexRedirect"]]);
  assert.deepEqual(classifyKeys(["A", "R", "W"]), [["badRoll"], ["goodRoll", "pinkyRedirect"]]);
  assert.deepEqual(classifyKeys(["Q", "D", "S"]), [["badRoll"], ["goodRoll", "pinkyRedirect"]]);

  assert.equal(isGoodRedirect("A", "V", "D"), true, "BIのVを含む");
  assert.deepEqual(classifyKeys(["A", "V", "D"]), [["goodRoll"], ["goodRoll", "indexRedirect"]]);

  assert.deepEqual(classifyKeys(["A", "D", "S"]), [["goodRoll"], ["goodRoll", "pinkyRedirect"]]);

  // HI/BIも小指も含まない redirect は middle。
  assert.deepEqual(classifyKeys(["S", "D", "S"]), [["goodRoll"], ["goodRoll", "middleRedirect"]]);
});

test("redirect: repeat/alt/sfbを挟んだ方向反転は三連接にしない", () => {
  assert.deepEqual(
    classifyKeys(["A", "D", "D", "S"]),
    [["goodRoll"], ["repeat"], ["goodRoll"]]
  );
  assert.deepEqual(classifyKeys(["A", "P"]), [["alt"]]);
  assert.deepEqual(classifyKeys(["A", "Q"]), [["sfb"]]);
});

test("SFS: 距離1Uも距離重み付きで集計する", () => {
  const oneUnit = metricsForKeys(["Q", "S", "A"]); // Q ... A = 1U
  const twoUnits = metricsForKeys(["R", "S", "V"]); // R ... V = 2U

  assert.equal(oneUnit.sfsRate, 0.5);
  assert.equal(twoUnits.sfsRate, 1.0);
  assert.equal(twoUnits.sfsRate, oneUnit.sfsRate * 2);
});

test("分類表示: bikey・redirect・SFSを同時に返す", () => {
  const moras = ["0", "1", "2"];
  const moraKeys = { "0": ["Q"], "1": ["S"], "2": ["A"] };
  const { steps } = classifyStream(moras, moraKeys);

  assert.deepEqual(steps[0].cats, [steps[0].cat]);
  assert.deepEqual(steps[1].cats, [steps[1].cat, "pinkyRedirect", "sfs"]);
});

test("例文入力: 日本語・カタカナ・ローマ字を配置のモーラへ変換する", () => {
  const known = ["き", "きゃ", "く", "。"];

  assert.deepEqual(textToMoras("きゃく。", known), ["きゃ", "く", "。"]);
  assert.deepEqual(textToMoras("キャク", known), ["きゃ", "く"]);
  assert.deepEqual(textToMoras("kyaku", known), ["きゃ", "く"]);
});

test("4分類がそれぞれ独立したweightを持つ", () => {
  const weights = defaultWeights().pen_flow;
  for (const category of ["indexRedirect", "pinkyRedirect", "middleRedirect", "goodRoll", "badRoll", "sfb", "sfs"]) {
    assert.equal(typeof weights[category], "number", category);
  }
});

test("bikeyのrollとtrikeyのredirectを同時に評価する", () => {
  const weights = defaultWeights();
  for (const category of Object.keys(weights.pen_flow)) weights.pen_flow[category] = 0;
  weights.pen_flow.goodRoll = 3;
  weights.pen_flow.pinkyRedirect = 5;
  const metrics = computeMetrics(
    {},
    { bigramList: [["first", "second", 1]] },
    weights,
    { first: ["A"], second: ["D", "S"] }
  );

  assert.equal(metrics.flowRates.goodRoll, 1);
  assert.equal(metrics.flowRates.pinkyRedirect, 0.5);
  // flow は連接あたりの質: (goodRoll 3×2連接 + pinkyRedirect 5×1) / 2連接 = 5.5
  assert.equal(metrics.flow, 5.5);
});

test("キー使用率: 全20キーが独立したweightを持つ", () => {
  const weights = defaultWeights();
  assert.deepEqual(Object.keys(weights.key_effort).sort(), [...SECOND_KEYS].sort());
  for (const removed of ["w_top", "w_index_stretch", "w_index_bottom", "finger_effort"]) {
    assert.equal(Object.hasOwn(weights, removed), false, removed);
  }
});

test("単打は「ん・い」の2つで、「う」は行列の2打にする", () => {
  const layout = defaultLayout();
  const moraKeys = buildMoraKeys(layout);

  assert.deepEqual(SINGLE_KEYS, ["F", "J"]);
  assert.equal(FIRST_KEYS.length, 18);
  assert.equal(MAT_SLOTS.length, 360);
  assert.deepEqual(layout.single, { F: "ん", J: "い" });
  assert.equal(moraKeys["う"].length, 2);
});

test("単打キーの位置・割当・個数はレイアウト定義に従う(自由化)", () => {
  const src = defaultLayout();
  for (const slot of MAT_SLOTS) {
    if (src.mat[slot] === "う") src.mat[slot] = "";
  }
  src.single = { D: "う", J: "い", K: "ん" };
  const normalized = normalizeLayout(src);
  const moraKeys = buildMoraKeys(normalized);

  // 単打はそのまま保持され、単打キーの列(第1キー)が行列から外れる。
  assert.deepEqual(normalized.single, { D: "う", J: "い", K: "ん" });
  assert.deepEqual(moraKeys["う"], ["D"]);
  assert.equal(Object.hasOwn(normalized.mat, "DA"), false);
  assert.equal(Object.hasOwn(normalized.mat, "FA"), true); // Fは単打でないので第1キーに戻る
  assert.equal(Object.keys(normalized.mat).length, 17 * 20);

  // 単打かなと重複する行列かなは除去される。
  const src2 = defaultLayout(); // あ が行列 QQ にある
  src2.single = { F: "あ", J: "い" };
  const n2 = normalizeLayout(src2);
  assert.deepEqual(buildMoraKeys(n2)["あ"], ["F"]);

  // single 未定義なら既定(F=ん, J=い)にフォールバック。
  const n3 = normalizeLayout({ mat: defaultLayout().mat });
  assert.deepEqual(n3.single, { F: "ん", J: "い" });

  // 空オブジェクト・空文字エントリは「単打なし/そのキーは単打でない」として尊重する。
  const n4 = normalizeLayout({ mat: defaultLayout().mat, single: {} });
  assert.deepEqual(n4.single, {});
  const n5 = normalizeLayout({ mat: defaultLayout().mat, single: { F: "ん", J: "" } });
  assert.deepEqual(n5.single, { F: "ん" });
  assert.equal(Object.hasOwn(n5.mat, "JA"), true); // Jの列は行列に復帰
});

test("キー使用率: キーごとの使用率とweightからeffortを計算する", () => {
  const weights = defaultWeights();
  weights.key_effort.Q = 4;
  weights.key_effort.A = 2;
  const metrics = computeMetrics(
    {},
    { bigramList: [["first", "second", 1]] },
    weights,
    { first: ["S"], second: ["Q", "A"] }
  );

  assert.equal(metrics.keyLoads.Q, 0.5);
  assert.equal(metrics.keyLoads.A, 0.5);
  // effort はモーラあたり: (4 + 2) / 1モーラ = 6(打鍵数の増加がそのままコストに乗る)。
  assert.equal(metrics.effort, 6);
  assert.equal(metrics.strokes, 2);
});

test("SFB/SFSはトップレベルweightではなくflowへ距離重み付きで加算する", () => {
  const weights = defaultWeights();
  assert.equal(Object.hasOwn(weights, "w_sfb"), false);
  assert.equal(Object.hasOwn(weights, "w_sfs"), false);

  const sfb = metricsForKeys(["Q", "A"]); // Q -> A = 1U
  assert.equal(sfb.sfbRate, 1);
  assert.equal(sfb.flowRates.sfb, sfb.sfbRate);
  assert.equal(sfb.flow, weights.pen_flow.sfb);

  const withSfs = metricsForKeys(["Q", "S", "A"]); // Q ... A = 1U
  const withoutSfsWeights = structuredClone(weights);
  withoutSfsWeights.pen_flow.sfs = 0;
  const withoutSfs = computeMetrics(
    {},
    { bigramList: [["first", "second", 1]] },
    withoutSfsWeights,
    { first: ["Q"], second: ["S", "A"] }
  );
  assert.equal(withSfs.flowRates.sfs, withSfs.sfsRate);
  // flow は連接あたり: SFS(距離1×1本)/2連接 = sfsRate×pen が差になる。
  assert.equal(withSfs.flow - withoutSfs.flow, withSfs.sfsRate * weights.pen_flow.sfs);
});

test("モーラ分解: splitMora と分解モードの moraKeys 合成", () => {
  assert.deepEqual(splitMora("しゃ"), ["し", "ゃ"]);
  assert.deepEqual(splitMora("ぎょ"), ["ぎ", "ょ"]);
  assert.deepEqual(splitMora("し"), ["し"]);
  // 外来語音(小書き母音)も分解対象。
  assert.deepEqual(splitMora("ふぁ"), ["ふ", "ぁ"]);
  assert.deepEqual(splitMora("てぃ"), ["て", "ぃ"]);
  assert.deepEqual(splitMora("うぉ"), ["う", "ぉ"]);
  assert.deepEqual(splitMora("ゔぇ"), ["ゔ", "ぇ"]);
  assert.deepEqual(splitMora("っ"), ["っ"]);
  // 拗音33種 + ふぁ行4 + うぉ + ゔぁ行4 + てぃ/でぃ + しぇ/じぇ/ちぇ = 47
  assert.equal(SPLIT_KANA.length, 47);

  const layout = { mat: { QA: "し", WS: "ゃ", ED: "しゃ" }, single: { F: "ん", J: "い" } };
  const combined = buildMoraKeys(layout, false);
  assert.deepEqual(combined["しゃ"], ["E", "D"]);
  const split = buildMoraKeys(layout, true);
  assert.deepEqual(split["しゃ"], ["Q", "A", "W", "S"]); // 配置セルより分解合成を優先
  assert.equal(buildMoraKeys({ mat: { QA: "し" }, single: {} }, true)["しゃ"], undefined);

  // 打鍵数はモーラあたりで比較可能(同じ ngram で 2打 vs 4打)。
  const ngram = { bigramList: [["ん", "しゃ", 1]] };
  const w = defaultWeights();
  const m2 = computeMetrics(layout, ngram, w, combined);
  const m4 = computeMetrics(layout, ngram, w, split);
  assert.equal(m2.strokes, 2);
  assert.equal(m4.strokes, 4);
});

test("配置サジェスト: 分解モードで拗音への波及を差分計算に含める", () => {
  const layout = { mat: { QA: "し", WS: "ゃ", ED: "か" }, single: { F: "ん", J: "い" } };
  const ngram = { bigramList: [["か", "しゃ", 3], ["しゃ", "か", 2], ["し", "か", 1], ["か", "い", 4]] };
  const weights = defaultWeights();
  const moraKeys = buildMoraKeys(layout, true);
  const unitsOf = (m) => { const u = splitMora(m); return u.length === 2 ? u : null; };

  // ゃ を空きスロット OL へ移動: しゃ を含む bigram すべてに波及する。
  const moved = structuredClone(layout);
  delete moved.mat.WS;
  moved.mat.OL = "ゃ";
  const fullMove = computeMetrics(moved, ngram, weights, buildMoraKeys(moved, true));
  const r1 = suggestPlacements(ngram, weights, moraKeys, "ゃ", "WS", [{ slot: "OL", occ: "" }], 1, 0.0005, unitsOf);
  assert.ok(Math.abs(r1.results[0].cost - fullMove.cost) < 1e-9, "空きへの移動が全再計算と一致");

  // し を か とスワップ: し・しゃ・か すべてに波及する。
  const swapped = structuredClone(layout);
  swapped.mat.QA = "か";
  swapped.mat.ED = "し";
  const fullSwap = computeMetrics(swapped, ngram, weights, buildMoraKeys(swapped, true));
  const r2 = suggestPlacements(ngram, weights, moraKeys, "し", "QA", [{ slot: "ED", occ: "か" }], 1, 0.0005, unitsOf);
  assert.ok(Math.abs(r2.results[0].cost - fullSwap.cost) < 1e-9, "スワップが全再計算と一致");
});

test("roll_move/vbounceは詳細flow評価への統合後に残さない", () => {
  const weights = defaultWeights();
  const metrics = metricsForKeys(["A", "S"]);

  assert.equal(Object.hasOwn(weights, "roll_move"), false);
  assert.equal(Object.hasOwn(weights, "w_vbounce"), false);
  assert.equal(Object.hasOwn(metrics, "vbounceRate"), false);
  assert.equal(Object.hasOwn(metrics, "devRates"), false);
});
