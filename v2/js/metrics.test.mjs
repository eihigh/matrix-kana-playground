// node --experimental-default-type=module --test v2/js/metrics.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyStream,
  computeMetrics,
  defaultWeights,
  isGoodRedirect,
  isGoodRoll,
} from "./metrics.js";
import { SECOND_KEYS } from "./layout.js";
import { textToMoras } from "./romaji.js";

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

test("redirect: 3キー中のHI/BI有無でgood/badを分ける", () => {
  assert.equal(isGoodRedirect("A", "F", "D"), true, "HIのFを含む");
  assert.deepEqual(classifyKeys(["A", "F", "D"]), [["goodRoll"], ["goodRoll", "goodRedirect"]]);

  assert.deepEqual(classifyKeys(["Q", "F", "W"]), [["badRoll"], ["goodRoll", "goodRedirect"]]);
  assert.deepEqual(classifyKeys(["A", "R", "W"]), [["badRoll"], ["goodRoll", "badRedirect"]]);
  assert.deepEqual(classifyKeys(["Q", "D", "S"]), [["badRoll"], ["goodRoll", "badRedirect"]]);

  assert.equal(isGoodRedirect("A", "V", "D"), true, "BIのVを含む");
  assert.deepEqual(classifyKeys(["A", "V", "D"]), [["goodRoll"], ["goodRoll", "goodRedirect"]]);

  assert.deepEqual(classifyKeys(["A", "D", "S"]), [["goodRoll"], ["goodRoll", "badRedirect"]]);
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
  assert.deepEqual(steps[1].cats, [steps[1].cat, "badRedirect", "sfs"]);
});

test("例文入力: 日本語・カタカナ・ローマ字を配置のモーラへ変換する", () => {
  const known = ["き", "きゃ", "く", "。"];

  assert.deepEqual(textToMoras("きゃく。", known), ["きゃ", "く", "。"]);
  assert.deepEqual(textToMoras("キャク", known), ["きゃ", "く"]);
  assert.deepEqual(textToMoras("kyaku", known), ["きゃ", "く"]);
});

test("4分類がそれぞれ独立したweightを持つ", () => {
  const weights = defaultWeights().pen_flow;
  for (const category of ["goodRedirect", "badRedirect", "goodRoll", "badRoll", "sfb", "sfs"]) {
    assert.equal(typeof weights[category], "number", category);
  }
});

test("bikeyのrollとtrikeyのredirectを同時に評価する", () => {
  const weights = defaultWeights();
  for (const category of Object.keys(weights.pen_flow)) weights.pen_flow[category] = 0;
  weights.pen_flow.goodRoll = 3;
  weights.pen_flow.badRedirect = 5;
  const metrics = computeMetrics(
    {},
    { bigramList: [["first", "second", 1]] },
    weights,
    { first: ["A"], second: ["D", "S"] }
  );

  assert.equal(metrics.flowRates.goodRoll, 1);
  assert.equal(metrics.flowRates.badRedirect, 0.5);
  assert.equal(metrics.flow, 5.5);
});

test("キー使用率: 全20キーが独立したweightを持つ", () => {
  const weights = defaultWeights();
  assert.deepEqual(Object.keys(weights.key_effort).sort(), [...SECOND_KEYS].sort());
  for (const removed of ["w_top", "w_index_stretch", "w_index_bottom", "finger_effort"]) {
    assert.equal(Object.hasOwn(weights, removed), false, removed);
  }
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
  assert.equal(metrics.effort, 3);
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
  assert.equal(withSfs.flow - withoutSfs.flow, withSfs.sfsRate * weights.pen_flow.sfs);
});

test("roll_move/vbounceは詳細flow評価への統合後に残さない", () => {
  const weights = defaultWeights();
  const metrics = metricsForKeys(["A", "S"]);

  assert.equal(Object.hasOwn(weights, "roll_move"), false);
  assert.equal(Object.hasOwn(weights, "w_vbounce"), false);
  assert.equal(Object.hasOwn(metrics, "vbounceRate"), false);
  assert.equal(Object.hasOwn(metrics, "devRates"), false);
});
