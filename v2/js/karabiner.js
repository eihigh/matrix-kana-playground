// かな直配列を Karabiner-Elements の complex modifications JSON にエクスポートする。
//
// 方式: 順次押しの状態機械。変数 kanachoku_pending が
//   0        = 待機
//   1..13    = 直前に押された第1キー(どれか)
// を表す。第1キーを押すと出力せず pending をセットし、続く任意キーが
// pending と一致して「第1キー+第2キー」のかなを IME にローマ字送出する。
// 単打キー(F/J/K)は待機中のみ う/い/ん を直接送出する。
// 発火条件は「日本語入力ソースが有効(input_source_if language ja)」のとき。
// 第1キーを押してから 0.5秒 以内に第2キーが来なければ pending を 0 に戻す
// (to_delayed_action)。放置しても状態が固まらないようにするため。

import { FIRST_KEYS, SECOND_KEYS, SINGLE_KEYS, KEY_CODE } from "./layout.js";

const VAR = "kanachoku_pending";

// 第1キー押下後、この時間内に第2キーが来なければ pending を 0 に戻す(ミリ秒)。
const PENDING_TIMEOUT_MS = 500;

// かな → ローマ字(IME にそのまま打鍵させる文字列)。
// くんれい/ワープロ式ベース。IME により小書き l/x 等は差異があるため要調整。
export const KANA_TO_ROMAJI = {
  "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
  "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
  "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
  "さ": "sa", "し": "si", "す": "su", "せ": "se", "そ": "so",
  "ざ": "za", "じ": "zi", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
  "た": "ta", "ち": "ti", "つ": "tu", "て": "te", "と": "to",
  "だ": "da", "ぢ": "di", "づ": "du", "で": "de", "ど": "do",
  "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
  "は": "ha", "ひ": "hi", "ふ": "hu", "へ": "he", "ほ": "ho",
  "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
  "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
  "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
  "や": "ya", "ゆ": "yu", "よ": "yo",
  "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
  "わ": "wa", "を": "wo", "ん": "nn",
  "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
  "しゃ": "sya", "しゅ": "syu", "しょ": "syo",
  "ちゃ": "tya", "ちゅ": "tyu", "ちょ": "tyo",
  "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
  "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
  "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
  "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
  "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
  "じゃ": "zya", "じゅ": "zyu", "じょ": "zyo",
  "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
  "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
  "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo",
  "うぉ": "who",
  "ゔぁ": "va", "ゔぃ": "vi", "ゔ": "vu", "ゔぇ": "ve", "ゔぉ": "vo",
  "てぃ": "thi", "でぃ": "dhi", "しぇ": "she", "じぇ": "je", "ちぇ": "che",
  "ぁ": "la", "ぃ": "li", "ぅ": "lu", "ぇ": "le", "ぉ": "lo",
  "っ": "ltu", "ー": "-", "、": ",", "。": ".",
};

// ローマ字1文字 → Karabiner key_code。
const CHAR_KEY = {
  "-": "hyphen", ",": "comma", ".": "period",
};
function charToKeyCode(ch) {
  if (CHAR_KEY[ch]) return CHAR_KEY[ch];
  return ch; // a-z はそのまま
}

// かなを IME へ送る打鍵イベント列。
function romajiEvents(kana) {
  const romaji = KANA_TO_ROMAJI[kana];
  if (!romaji) return [];
  return [...romaji].map((ch) => ({ key_code: charToKeyCode(ch) }));
}

const jaCondition = {
  type: "input_source_if",
  input_sources: [{ language: "ja" }],
};
const pendingIs = (v) => ({ type: "variable_if", name: VAR, value: v });
const setPending = (v) => ({ set_variable: { name: VAR, value: v } });

// layout = { mat, single } から complex modifications JSON オブジェクトを生成。
// keyCodes: 16キー(論理キー)→ Karabiner key_code の対応表(FROM側の物理キー)。
//   非QWERTYベース配列に合わせて差し替え可能。省略時は既定(QWERTY)の KEY_CODE。
export function buildKarabinerJSON(layout, keyCodes) {
  const kc = keyCodes || KEY_CODE;
  const manipulators = [];

  // 第1キー → pending 値(1..13)。
  const firstIndex = {};
  FIRST_KEYS.forEach((k, i) => { firstIndex[k] = i + 1; });

  // 1) 完了ルール(pending=i のとき第2キーを押す → かな送出＋リセット)。
  //    条件が互いに排他なので pending 未セットのルールより前に置く。
  for (const f of FIRST_KEYS) {
    const i = firstIndex[f];
    for (const s of SECOND_KEYS) {
      const kana = layout.mat[f + s];
      const to = [];
      if (kana) to.push(...romajiEvents(kana));
      to.push(setPending(0));
      manipulators.push({
        type: "basic",
        from: { key_code: kc[s] },
        to,
        conditions: [jaCondition, pendingIs(i)],
      });
    }
  }

  // 2) 第1キーの押下(pending=0 → 出力せず pending=i)。
  //    0.5秒以内に第2キーが来なければ to_delayed_action で pending を 0 に戻す。
  for (const f of FIRST_KEYS) {
    manipulators.push({
      type: "basic",
      from: { key_code: kc[f] },
      to: [setPending(firstIndex[f])],
      to_delayed_action: {
        to_if_invoked: [setPending(0)],
      },
      parameters: {
        "basic.to_delayed_action_delay_milliseconds": PENDING_TIMEOUT_MS,
      },
      conditions: [jaCondition, pendingIs(0)],
    });
  }

  // 単打キー(pending=0 → う/い/ん を直接送出)。
  for (const key of SINGLE_KEYS) {
    const kana = layout.single[key];
    const to = [];
    if (kana) to.push(...romajiEvents(kana));
    to.push(setPending(0));
    manipulators.push({
      type: "basic",
      from: { key_code: kc[key] },
      to,
      conditions: [jaCondition, pendingIs(0)],
    });
  }

  // Karabiner の complex modifications 取り込みが期待する「単一ルール」形式。
  //   { description, manipulators } を最上位に置く({title, rules} でラップしない)。
  return {
    description: "かな直: 2打かな入力(日本語入力時のみ)",
    manipulators,
  };
}

export function exportKarabinerString(layout, keyCodes) {
  return JSON.stringify(buildKarabinerJSON(layout, keyCodes), null, 2);
}
