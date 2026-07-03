// かな直 v2 のキー定義・スロット・かな集合。
// optimize.py の KEYMAP / SINGLE_KEYS / KANA_LIST に対応し、16キー化した版。

// 指の並び順(fid 0..7)。弱い指→強い指→強い指→弱い指(左右)。
export const FINGER_ORDER = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP"];
export const FID = Object.fromEntries(FINGER_ORDER.map((f, i) => [f, i]));

// キー定義: key -> {hand, finger, row}。row は "top" | "home"。
// 上段: Q W E R / U I O P、ホーム: A S D F / J K L ;
export const KEYMAP = {
  "Q": { hand: "L", finger: "LP", row: "top" },
  "W": { hand: "L", finger: "LR", row: "top" },
  "E": { hand: "L", finger: "LM", row: "top" },
  "R": { hand: "L", finger: "LI", row: "top" },
  "A": { hand: "L", finger: "LP", row: "home" },
  "S": { hand: "L", finger: "LR", row: "home" },
  "D": { hand: "L", finger: "LM", row: "home" },
  "F": { hand: "L", finger: "LI", row: "home" },
  "U": { hand: "R", finger: "RI", row: "top" },
  "I": { hand: "R", finger: "RM", row: "top" },
  "O": { hand: "R", finger: "RR", row: "top" },
  "P": { hand: "R", finger: "RP", row: "top" },
  "J": { hand: "R", finger: "RI", row: "home" },
  "K": { hand: "R", finger: "RM", row: "home" },
  "L": { hand: "R", finger: "RR", row: "home" },
  ";": { hand: "R", finger: "RP", row: "home" },
};

// Karabiner エクスポート用: 各キーの JIS/US キーコード。
export const KEY_CODE = {
  "Q": "q", "W": "w", "E": "e", "R": "r",
  "A": "a", "S": "s", "D": "d", "F": "f",
  "U": "u", "I": "i", "O": "o", "P": "p",
  "J": "j", "K": "k", "L": "l", ";": "semicolon",
};

// 単打キー(3つ)。ここには う・い・ん のみ配置(行列には出ない)。
export const SINGLE_KEYS = ["F", "J", "K"];
export const SINGLE_KANA = ["ん", "い", "う"];

// 第2キー(16種)。ホーム段を中央に寄せ、上段を外側に置く並び(v1準拠)。
//   左: 上段 Q W E R → ホーム A S D F(内側) / 右: ホーム J K L ;(内側) → 上段 U I O P
// これで ホーム段同士のセルがグリッド中央に集まり、人間に見やすくなる。
export const SECOND_KEYS = [
  "Q", "W", "E", "R", "A", "S", "D", "F",
  "J", "K", "L", ";", "U", "I", "O", "P",
];
// 第1キー(単打キーを除く13種)。
export const FIRST_KEYS = SECOND_KEYS.filter((k) => !SINGLE_KEYS.includes(k));

// 行列スロット(第1キー × 第2キー = 13×16 = 208)。id は 2文字連結。
export const MAT_SLOTS = [];
for (const f of FIRST_KEYS) {
  for (const s of SECOND_KEYS) {
    MAT_SLOTS.push(f + s);
  }
}

// 行列に配置しうるモーラ集合(単打を除く)。かな直では「うぉ」を追加。
export const KANA_LIST = [
  "あ", "え", "お",
  "か", "き", "く", "け", "こ",
  "さ", "し", "す", "せ", "そ",
  "た", "ち", "つ", "て", "と",
  "な", "に", "ぬ", "ね", "の",
  "は", "ひ", "ふ", "へ", "ほ",
  "ま", "み", "む", "め", "も",
  "や", "ゆ", "よ",
  "ら", "り", "る", "れ", "ろ",
  "わ", "を",
  "が", "ぎ", "ぐ", "げ", "ご",
  "ざ", "じ", "ず", "ぜ", "ぞ",
  "だ", "ぢ", "づ", "で", "ど",
  "ば", "び", "ぶ", "べ", "ぼ",
  "ぱ", "ぴ", "ぷ", "ぺ", "ぽ",
  "きゃ", "きゅ", "きょ",
  "しゃ", "しゅ", "しょ",
  "ちゃ", "ちゅ", "ちょ",
  "にゃ", "にゅ", "にょ",
  "ひゃ", "ひゅ", "ひょ",
  "みゃ", "みゅ", "みょ",
  "りゃ", "りゅ", "りょ",
  "ぎゃ", "ぎゅ", "ぎょ",
  "じゃ", "じゅ", "じょ",
  "びゃ", "びゅ", "びょ",
  "ぴゃ", "ぴゅ", "ぴょ",
  "ふぁ", "ふぃ", "ふぇ", "ふぉ",
  "うぉ",
  "ゔぁ", "ゔぃ", "ゔ", "ゔぇ", "ゔぉ",
  "てぃ", "でぃ", "しぇ", "じぇ", "ちぇ",
  "ぁ", "ぃ", "ぅ", "ぇ", "ぉ",
  "っ", "ー", "、", "。",
];

// 2キー連接の分類: repeat(同キー) / sfb(同指別キー) / roll(同手別指) / alt(逆手)。
export function classifyPair(k1, k2) {
  if (k1 === k2) return "repeat";
  if (KEYMAP[k1].finger === KEYMAP[k2].finger) return "sfb";
  if (KEYMAP[k1].hand === KEYMAP[k2].hand) return "roll";
  return "alt";
}

// あるモーラを打つ物理キー列を返す(行列は2キー、単打は1キー)。
// layout = { mat: {slotId: kana}, single: {F,J,K: kana} }。
export function buildMoraKeys(layout) {
  const moraKeys = {};
  for (const slot of MAT_SLOTS) {
    const kana = layout.mat[slot];
    if (kana) moraKeys[kana] = [slot[0], slot.slice(1)];
  }
  for (const key of SINGLE_KEYS) {
    const kana = layout.single[key];
    if (kana) moraKeys[kana] = [key];
  }
  return moraKeys;
}

// デフォルト配列: KANA_LIST を行列スロットに順番に敷き詰め、余りは空。
// 単打は F=ん, J=い, K=う。
export function defaultLayout() {
  const mat = {};
  MAT_SLOTS.forEach((slot, i) => {
    mat[slot] = i < KANA_LIST.length ? KANA_LIST[i] : "";
  });
  const single = {};
  SINGLE_KEYS.forEach((key, i) => {
    single[key] = SINGLE_KANA[i];
  });
  return { mat, single };
}

// レイアウトの複製。
export function cloneLayout(layout) {
  return {
    mat: { ...layout.mat },
    single: { ...layout.single },
  };
}
