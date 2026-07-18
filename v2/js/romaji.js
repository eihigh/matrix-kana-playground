// ローマ字コーパスをモーラ列へ変換する(ngram/convert.go の RomajiToMoras 移植)。
// タイピング練習で jap-n.txt を「かな直のモーラ単位(ひらがな)」に直すために使う。

// 語境界マーカー(空白由来)。bigram をまたがせない・練習では区切りとして扱う。
export const BREAK = "\x00";

const vowels = new Set(["a", "i", "u", "e", "o"]);
// 促音を生む子音(n は撥音なので除外)。
const sokuonCons = new Set([
  "k", "g", "s", "z", "t", "d", "h", "b", "p", "m", "y", "r", "w", "f", "v", "j", "c",
]);

// ローマ字 → モーラ列の longest-match テーブル。
const table = {
  "a": ["あ"], "i": ["い"], "u": ["う"], "e": ["え"], "o": ["お"],
  "ka": ["か"], "ki": ["き"], "ku": ["く"], "ke": ["け"], "ko": ["こ"],
  "ga": ["が"], "gi": ["ぎ"], "gu": ["ぐ"], "ge": ["げ"], "go": ["ご"],
  "sa": ["さ"], "si": ["し"], "shi": ["し"], "su": ["す"], "se": ["せ"], "so": ["そ"],
  "za": ["ざ"], "zi": ["じ"], "ji": ["じ"], "zu": ["ず"], "ze": ["ぜ"], "zo": ["ぞ"],
  "ta": ["た"], "ti": ["ち"], "chi": ["ち"], "tu": ["つ"], "tsu": ["つ"], "te": ["て"], "to": ["と"],
  "da": ["だ"], "di": ["ぢ"], "du": ["づ"], "de": ["で"], "do": ["ど"],
  "na": ["な"], "ni": ["に"], "nu": ["ぬ"], "ne": ["ね"], "no": ["の"],
  "ha": ["は"], "hi": ["ひ"], "hu": ["ふ"], "fu": ["ふ"], "he": ["へ"], "ho": ["ほ"],
  "ba": ["ば"], "bi": ["び"], "bu": ["ぶ"], "be": ["べ"], "bo": ["ぼ"],
  "pa": ["ぱ"], "pi": ["ぴ"], "pu": ["ぷ"], "pe": ["ぺ"], "po": ["ぽ"],
  "ma": ["ま"], "mi": ["み"], "mu": ["む"], "me": ["め"], "mo": ["も"],
  "ya": ["や"], "yu": ["ゆ"], "yo": ["よ"],
  "ra": ["ら"], "ri": ["り"], "ru": ["る"], "re": ["れ"], "ro": ["ろ"],
  "wa": ["わ"], "wo": ["を"],
  "kya": ["きゃ"], "kyu": ["きゅ"], "kyo": ["きょ"],
  "gya": ["ぎゃ"], "gyu": ["ぎゅ"], "gyo": ["ぎょ"],
  "sya": ["しゃ"], "syu": ["しゅ"], "syo": ["しょ"],
  "sha": ["しゃ"], "shu": ["しゅ"], "sho": ["しょ"],
  "zya": ["じゃ"], "zyu": ["じゅ"], "zyo": ["じょ"],
  "ja": ["じゃ"], "ju": ["じゅ"], "jo": ["じょ"],
  "tya": ["ちゃ"], "tyu": ["ちゅ"], "tyo": ["ちょ"],
  "cha": ["ちゃ"], "chu": ["ちゅ"], "cho": ["ちょ"],
  "nya": ["にゃ"], "nyu": ["にゅ"], "nyo": ["にょ"],
  "hya": ["ひゃ"], "hyu": ["ひゅ"], "hyo": ["ひょ"],
  "mya": ["みゃ"], "myu": ["みゅ"], "myo": ["みょ"],
  "rya": ["りゃ"], "ryu": ["りゅ"], "ryo": ["りょ"],
  "bya": ["びゃ"], "byu": ["びゅ"], "byo": ["びょ"],
  "pya": ["ぴゃ"], "pyu": ["ぴゅ"], "pyo": ["ぴょ"],
  "fa": ["ふぁ"], "fi": ["ふぃ"], "fe": ["ふぇ"], "fo": ["ふぉ"],
  "va": ["ゔぁ"], "vi": ["ゔぃ"], "vu": ["ゔ"], "ve": ["ゔぇ"], "vo": ["ゔぉ"],
  "thi": ["てぃ"], "dhi": ["でぃ"],
  "she": ["しぇ"], "je": ["じぇ"], "che": ["ちぇ"], "tye": ["ちぇ"],
  "tsa": ["つ", "ぁ"], "tsi": ["つ", "ぃ"], "tse": ["つ", "ぇ"], "tso": ["つ", "ぉ"],
  "wi": ["う", "ぃ"], "we": ["う", "ぇ"],
  "wha": ["う", "ぁ"], "whi": ["う", "ぃ"], "whu": ["う"],
  "whe": ["う", "ぇ"], "who": ["うぉ"],
  "ye": ["い", "ぇ"],
  "la": ["ぁ"], "li": ["ぃ"], "lu": ["ぅ"], "le": ["ぇ"], "lo": ["ぉ"],
  "xa": ["ぁ"], "xi": ["ぃ"], "xu": ["ぅ"], "xe": ["ぇ"], "xo": ["ぉ"],
  "lya": ["ゃ"], "lyu": ["ゅ"], "lyo": ["ょ"],
  "xya": ["ゃ"], "xyu": ["ゅ"], "xyo": ["ょ"],
  "ltu": ["っ"], "xtu": ["っ"], "ltsu": ["っ"], "xtsu": ["っ"],
  "-": ["ー"], ",": ["、"], ".": ["。"],
};

let maxLen = 0;
for (const k of Object.keys(table)) if (k.length > maxLen) maxLen = k.length;

// ローマ字文字列 → モーラ列(空白は BREAK)。convert.go と同一ロジック。
export function romajiToMoras(text) {
  const s = text.toLowerCase();
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") { out.push(BREAK); i++; continue; }
    // 撥音 ん
    if (c === "n") {
      const nxt = i + 1 < n ? s[i + 1] : "";
      if (nxt === "n") { out.push("ん"); i += 2; continue; }
      if (!(vowels.has(nxt) || nxt === "y")) { out.push("ん"); i++; continue; }
      // 母音/y の前は な行/にゃ行としてテーブル照合へ。
    }
    // 促音(子音重ね)。l/x 接頭の促音はテーブル側で処理。
    if (sokuonCons.has(c) && c !== "n" && i + 1 < n && s[i + 1] === c && c !== "l" && c !== "x") {
      out.push("っ"); i++; continue;
    }
    // longest-match
    let matched = false;
    const hi = Math.min(maxLen, n - i);
    for (let L = hi; L >= 1; L--) {
      const seg = s.slice(i, i + L);
      const v = table[seg];
      if (v) { out.push(...v); i += L; matched = true; break; }
    }
    if (matched) continue;
    i++; // 未対応はスキップ
  }
  return out;
}

// 日本語またはローマ字の自由入力を、現在の配置にある最長一致のモーラ列へ変換する。
export function textToMoras(text, knownMoras = []) {
  const normalized = String(text).normalize("NFKC").replace(/[ァ-ヶ]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
  const candidates = [...new Set(knownMoras)].filter(Boolean).sort((a, b) => b.length - a.length);
  const out = [];

  for (let i = 0; i < normalized.length;) {
    if (/\s/.test(normalized[i])) { i++; continue; }

    const ascii = normalized.slice(i).match(/^[A-Za-z.,-]+/);
    if (ascii) {
      out.push(...romajiToMoras(ascii[0]).filter((mora) => mora !== BREAK));
      i += ascii[0].length;
      continue;
    }

    const matched = candidates.find((mora) => normalized.startsWith(mora, i));
    if (matched) {
      out.push(matched);
      i += matched.length;
    } else {
      const [char] = Array.from(normalized.slice(i));
      out.push(char);
      i += char.length;
    }
  }
  return out;
}
