// かな直 v2 のキー定義・スロット・かな集合。
// optimize.py の KEYMAP / SINGLE_KEYS / KANA_LIST に対応し、16キー化した版。

// 指の並び順(fid 0..7)。弱い指→強い指→強い指→弱い指(左右)。
export const FINGER_ORDER = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP"];
export const FID = Object.fromEntries(FINGER_ORDER.map((f, i) => [f, i]));

// キー定義: key -> {hand, finger, row, x, y, stretch}。
//   row  : "top" | "home" | "bottom"(段の名前。上段率/下段率などの集計に使う)
//   x, y : キーの物理座標。y は home=0, top=-1, bottom=+1。x は左端 0 から右へ。
//          SFB の距離重みはこの座標から計算する。
//   stretch: 人差し指の内側列(G, H)。人差し拡張率の集計に使う。
//
// 列(x)の割り当て:
//   左  LP=0 LR=1 LM=2 LI(ホーム列)=3 LI(内側列)=4
//   右  RI(内側列)=5 RI(ホーム列)=6 RM=7 RR=8 RP=9
// 人差し指の拡張は内側ホーム(G/H)と下段(V/M)のみ採用:
//   左: R/F/V(x=3) と G(x=4)、右: H(x=5) と U/J/M(x=6)。
export const KEYMAP = {
  "Q": { hand: "L", finger: "LP", row: "top",    x: 0, y: -1 },
  "W": { hand: "L", finger: "LR", row: "top",    x: 1, y: -1 },
  "E": { hand: "L", finger: "LM", row: "top",    x: 2, y: -1 },
  "R": { hand: "L", finger: "LI", row: "top",    x: 3, y: -1 },
  "A": { hand: "L", finger: "LP", row: "home",   x: 0, y: 0 },
  "S": { hand: "L", finger: "LR", row: "home",   x: 1, y: 0 },
  "D": { hand: "L", finger: "LM", row: "home",   x: 2, y: 0 },
  "F": { hand: "L", finger: "LI", row: "home",   x: 3, y: 0 },
  "G": { hand: "L", finger: "LI", row: "home",   x: 4, y: 0, stretch: true },
  "V": { hand: "L", finger: "LI", row: "bottom", x: 3, y: 1 },
  "U": { hand: "R", finger: "RI", row: "top",    x: 6, y: -1 },
  "I": { hand: "R", finger: "RM", row: "top",    x: 7, y: -1 },
  "O": { hand: "R", finger: "RR", row: "top",    x: 8, y: -1 },
  "P": { hand: "R", finger: "RP", row: "top",    x: 9, y: -1 },
  "H": { hand: "R", finger: "RI", row: "home",   x: 5, y: 0, stretch: true },
  "J": { hand: "R", finger: "RI", row: "home",   x: 6, y: 0 },
  "K": { hand: "R", finger: "RM", row: "home",   x: 7, y: 0 },
  "L": { hand: "R", finger: "RR", row: "home",   x: 8, y: 0 },
  ";": { hand: "R", finger: "RP", row: "home",   x: 9, y: 0 },
  "M": { hand: "R", finger: "RI", row: "bottom", x: 6, y: 1 },
};

// Karabiner エクスポート用: 各キーの JIS/US キーコード。
export const KEY_CODE = {
  "Q": "q", "W": "w", "E": "e", "R": "r",
  "A": "a", "S": "s", "D": "d", "F": "f", "G": "g",
  "V": "v",
  "U": "u", "I": "i", "O": "o", "P": "p",
  "H": "h", "J": "j", "K": "k", "L": "l", ";": "semicolon",
  "M": "m",
};

// 既定の単打キー(2つ)と既定の単打かな。
// 単打キーの位置・割当はレイアウトごとに自由(layout.single のキー集合が真実)。
// 以下の定数は既定レイアウトと旧データ互換のためのデフォルト値。
export const SINGLE_KEYS = ["F", "J"];
export const SINGLE_KANA = ["ん", "い"];

// レイアウトから単打キー集合を得る。
export function singleKeysOf(layout) {
  return Object.keys(layout.single);
}

// 単打キー集合に対する第1キー集合(単打キーは第1キーになれない)。
export function firstKeysOf(singleKeys) {
  return SECOND_KEYS.filter((k) => !singleKeys.includes(k));
}

// 単打キー集合に対する行列スロット一覧。
export function matSlotsOf(singleKeys) {
  const slots = [];
  for (const f of firstKeysOf(singleKeys)) {
    for (const s of SECOND_KEYS) slots.push(f + s);
  }
  return slots;
}

// 第2キー(20種)。左右で外側→内側の順に並べ、人差し指の拡張キー(内側ホーム/下段)を
// 中央寄りにまとめる。中央の仕切りを挟んで 下段 V｜M、その外に 内側ホーム G｜H が
// 来る左右対称の並び。
export const SECOND_KEYS = [
  "Q", "W", "E", "R", "A", "S", "D", "F", "V", "G",
  "H", "M", "J", "K", "L", ";", "U", "I", "O", "P",
];
// 第1キー(単打キーを除く18種)。
export const FIRST_KEYS = SECOND_KEYS.filter((k) => !SINGLE_KEYS.includes(k));

// 行列スロット(第1キー × 第2キー = 18×20 = 360)。id は 2文字連結。
export const MAT_SLOTS = [];
for (const f of FIRST_KEYS) {
  for (const s of SECOND_KEYS) {
    MAT_SLOTS.push(f + s);
  }
}

// 行列に配置しうるモーラ集合(単打を除く)。かな直では「うぉ」を追加。
export const KANA_LIST = [
  "あ", "う", "え", "お",
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

// 分解モード専用の小書きかな(ゃゅょ)。一体モードでは行列に存在せず、
// モード切替で配置・退避される。ぁぃぅぇぉは両モードで行列に存在する通常かな。
export const SMALL_YOON = ["ゃ", "ゅ", "ょ"];
// 合成に使う小書きかな全体(拗音 ゃゅょ + 小書き母音 ぁぃぅぇぉ)。
const SMALL_ALL = new Set([...SMALL_YOON, "ぁ", "ぃ", "ぅ", "ぇ", "ぉ"]);
// 分解対象モーラ(拗音33種 + ふぁ・てぃ・しぇ・うぉ・ゔぁ 等の外来語音)。
export const SPLIT_KANA = KANA_LIST.filter(
  (m) => m.length === 2 && SMALL_ALL.has(m[1])
);

// モーラ分解: しゃ → [し, ゃ]、ふぁ → [ふ, ぁ]。分解対象でなければ [そのまま]。
export function splitMora(mora) {
  const last = mora[mora.length - 1];
  if (mora.length >= 2 && SMALL_ALL.has(last)) {
    return [mora.slice(0, -1), last];
  }
  return [mora];
}

// 2キー連接の分類: repeat(同キー) / sfb(同指別キー) / roll(同手別指) / alt(逆手)。
export function classifyPair(k1, k2) {
  if (k1 === k2) return "repeat";
  if (KEYMAP[k1].finger === KEYMAP[k2].finger) return "sfb";
  if (KEYMAP[k1].hand === KEYMAP[k2].hand) return "roll";
  return "alt";
}

// 2キーの物理距離(ユークリッド)。SFB の重みに使う。
// 非人差し指の同指キーは上下段のみ(Δx=0,Δy=1)なので距離=1 になり従来と一致する。
export function keyDist(k1, k2) {
  const a = KEYMAP[k1], b = KEYMAP[k2];
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// あるモーラを打つ物理キー列を返す(行列は2キー、単打は1キー)。
// layout = { mat: {slotId: kana}, single: {key: kana} }。
// mat/single のキー集合はレイアウト自身が持つ(単打キーの位置は固定しない)。
// yoonSplit=true(拗音分解モード)では、拗音のキー列を配置からではなく
// 「基底かな＋小書きかな」の連結として導出する(しゃ = keys(し)++keys(ゃ))。
// ngram のモーラ集合はそのままなので、モーラあたり正規化はモード間で比較可能。
export function buildMoraKeys(layout, yoonSplit = false) {
  const moraKeys = {};
  for (const [slot, kana] of Object.entries(layout.mat)) {
    if (kana) moraKeys[kana] = [slot[0], slot.slice(1)];
  }
  for (const [key, kana] of Object.entries(layout.single)) {
    if (kana) moraKeys[kana] = [key];
  }
  if (yoonSplit) {
    for (const mora of SPLIT_KANA) {
      delete moraKeys[mora]; // 万一配置が残っていても分解合成を優先
      const [base, small] = splitMora(mora);
      if (moraKeys[base] && moraKeys[small]) {
        moraKeys[mora] = [...moraKeys[base], ...moraKeys[small]];
      }
    }
  }
  return moraKeys;
}

// デフォルト配列: KANA_LIST を行列スロットに順番に敷き詰め、余りは空。
// 単打は F=ん, J=い。「う」は行列に配置する。
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
