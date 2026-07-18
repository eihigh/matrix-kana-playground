package main

// ローマ字コーパスを かな直 専用モーラ列へ変換する。
//
// build_ngram.py のロジックを移植したもの。かな直 v2 では外来音「うぉ」を
// 専用ユニット化している(who → うぉ)。
//   - youon は sh/ty/j 等ヘボン混在、外来音は f/v/th/dh/ts、小書きは l/x 接頭。
//   - 長音は "-"(→ー)、句読点は ","(→、) "."(→。)。
//   - 撥音 ん は "nn"(母音/y の前) もしくは "n"(子音・語末)。
//   - 促音 っ は子音重ね、または ltu/xtu/ltsu/xtsu。

// Break は空白(語境界)を表すマーカー。bigram をまたがせない。
const Break = "\x00"

// KanaList は行列に配置しうるモーラ単位の集合(単打を除く)。
// optimize.py / build_ngram.py の KANA_LIST に「うぉ」を追加したもの。
var KanaList = []string{
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
}

// SingleKana は単打キー(F・J)に置くモーラ。
var SingleKana = []string{"ん", "い"}

// validUnits は KanaList と SingleKana の和集合。
var validUnits = func() map[string]bool {
	m := make(map[string]bool)
	for _, k := range KanaList {
		m[k] = true
	}
	for _, k := range SingleKana {
		m[k] = true
	}
	return m
}()

var vowels = map[byte]bool{'a': true, 'i': true, 'u': true, 'e': true, 'o': true}

// sokuonCons は促音を生む子音(n は撥音なので除外)。
var sokuonCons = map[byte]bool{
	'k': true, 'g': true, 's': true, 'z': true, 't': true, 'd': true,
	'h': true, 'b': true, 'p': true, 'm': true, 'y': true, 'r': true,
	'w': true, 'f': true, 'v': true, 'j': true, 'c': true,
}

// table はローマ字→モーラ列の longest-match テーブル。
var table = map[string][]string{
	// 単独母音
	"a": {"あ"}, "i": {"い"}, "u": {"う"}, "e": {"え"}, "o": {"お"},
	// か行/が行
	"ka": {"か"}, "ki": {"き"}, "ku": {"く"}, "ke": {"け"}, "ko": {"こ"},
	"ga": {"が"}, "gi": {"ぎ"}, "gu": {"ぐ"}, "ge": {"げ"}, "go": {"ご"},
	// さ行(くんれい si / ヘボン shi 両対応)
	"sa": {"さ"}, "si": {"し"}, "shi": {"し"}, "su": {"す"}, "se": {"せ"}, "so": {"そ"},
	"za": {"ざ"}, "zi": {"じ"}, "ji": {"じ"}, "zu": {"ず"}, "ze": {"ぜ"}, "zo": {"ぞ"},
	// た行(くんれい ti/tu/di/du、ヘボン chi/tsu 両対応)
	"ta": {"た"}, "ti": {"ち"}, "chi": {"ち"}, "tu": {"つ"}, "tsu": {"つ"},
	"te": {"て"}, "to": {"と"},
	"da": {"だ"}, "di": {"ぢ"}, "du": {"づ"}, "de": {"で"}, "do": {"ど"},
	// な行
	"na": {"な"}, "ni": {"に"}, "nu": {"ぬ"}, "ne": {"ね"}, "no": {"の"},
	// は行(くんれい hu / ヘボン fu)
	"ha": {"は"}, "hi": {"ひ"}, "hu": {"ふ"}, "fu": {"ふ"}, "he": {"へ"}, "ho": {"ほ"},
	"ba": {"ば"}, "bi": {"び"}, "bu": {"ぶ"}, "be": {"べ"}, "bo": {"ぼ"},
	"pa": {"ぱ"}, "pi": {"ぴ"}, "pu": {"ぷ"}, "pe": {"ぺ"}, "po": {"ぽ"},
	// ま行
	"ma": {"ま"}, "mi": {"み"}, "mu": {"む"}, "me": {"め"}, "mo": {"も"},
	// や行
	"ya": {"や"}, "yu": {"ゆ"}, "yo": {"よ"},
	// ら行
	"ra": {"ら"}, "ri": {"り"}, "ru": {"る"}, "re": {"れ"}, "ro": {"ろ"},
	// わ行
	"wa": {"わ"}, "wo": {"を"},
	// 拗音(1モーラに結合)
	"kya": {"きゃ"}, "kyu": {"きゅ"}, "kyo": {"きょ"},
	"gya": {"ぎゃ"}, "gyu": {"ぎゅ"}, "gyo": {"ぎょ"},
	"sya": {"しゃ"}, "syu": {"しゅ"}, "syo": {"しょ"},
	"sha": {"しゃ"}, "shu": {"しゅ"}, "sho": {"しょ"},
	"zya": {"じゃ"}, "zyu": {"じゅ"}, "zyo": {"じょ"},
	"ja": {"じゃ"}, "ju": {"じゅ"}, "jo": {"じょ"},
	"tya": {"ちゃ"}, "tyu": {"ちゅ"}, "tyo": {"ちょ"},
	"cha": {"ちゃ"}, "chu": {"ちゅ"}, "cho": {"ちょ"},
	"nya": {"にゃ"}, "nyu": {"にゅ"}, "nyo": {"にょ"},
	"hya": {"ひゃ"}, "hyu": {"ひゅ"}, "hyo": {"ひょ"},
	"mya": {"みゃ"}, "myu": {"みゅ"}, "myo": {"みょ"},
	"rya": {"りゃ"}, "ryu": {"りゅ"}, "ryo": {"りょ"},
	"bya": {"びゃ"}, "byu": {"びゅ"}, "byo": {"びょ"},
	"pya": {"ぴゃ"}, "pyu": {"ぴゅ"}, "pyo": {"ぴょ"},
	// 外来音(専用ユニット)
	"fa": {"ふぁ"}, "fi": {"ふぃ"}, "fe": {"ふぇ"}, "fo": {"ふぉ"},
	"va": {"ゔぁ"}, "vi": {"ゔぃ"}, "vu": {"ゔ"}, "ve": {"ゔぇ"}, "vo": {"ゔぉ"},
	"thi": {"てぃ"}, "dhi": {"でぃ"},
	"she": {"しぇ"}, "je": {"じぇ"}, "che": {"ちぇ"}, "tye": {"ちぇ"},
	// 外来音(専用ユニットが無く 基音+小書き に分割)
	"tsa": {"つ", "ぁ"}, "tsi": {"つ", "ぃ"}, "tse": {"つ", "ぇ"}, "tso": {"つ", "ぉ"},
	"wi": {"う", "ぃ"}, "we": {"う", "ぇ"},
	"wha": {"う", "ぁ"}, "whi": {"う", "ぃ"}, "whu": {"う"},
	"whe": {"う", "ぇ"}, "who": {"うぉ"},
	"ye": {"い", "ぇ"},
	// 小書き単独(ワープロ式 l/x 接頭)
	"la": {"ぁ"}, "li": {"ぃ"}, "lu": {"ぅ"}, "le": {"ぇ"}, "lo": {"ぉ"},
	"xa": {"ぁ"}, "xi": {"ぃ"}, "xu": {"ぅ"}, "xe": {"ぇ"}, "xo": {"ぉ"},
	"lya": {"ゃ"}, "lyu": {"ゅ"}, "lyo": {"ょ"},
	"xya": {"ゃ"}, "xyu": {"ゅ"}, "xyo": {"ょ"},
	"ltu": {"っ"}, "xtu": {"っ"}, "ltsu": {"っ"}, "xtsu": {"っ"},
	// 記号
	"-": {"ー"}, ",": {"、"}, ".": {"。"},
}

var maxLen = func() int {
	m := 0
	for k := range table {
		if len(k) > m {
			m = len(k)
		}
	}
	return m
}()

// RomajiToMoras はローマ字文字列をモーラ列へ変換する。
// 空白(スペース・改行・タブ)は Break で区切る。
// 2つ目の戻り値は未対応だったバイト(小文字)の出現数。
func RomajiToMoras(text string) ([]string, map[byte]int) {
	s := toLowerASCII(text)
	n := len(s)
	out := []string{}
	unmatched := map[byte]int{}
	i := 0
	for i < n {
		c := s[i]
		// 空白 → 語境界
		if c == ' ' || c == '\n' || c == '\t' || c == '\r' {
			out = append(out, Break)
			i++
			continue
		}
		// 撥音 ん
		if c == 'n' {
			var nxt byte
			if i+1 < n {
				nxt = s[i+1]
			}
			if nxt == 'n' {
				out = append(out, "ん")
				i += 2
				continue
			}
			if vowels[nxt] || nxt == 'y' {
				// な行/にゃ行として下のテーブル照合に回す
			} else {
				out = append(out, "ん")
				i++
				continue
			}
		}
		// 促音(子音重ね)。l/x 接頭の促音はテーブル側(ltu 等)で処理。
		if sokuonCons[c] && c != 'n' && i+1 < n && s[i+1] == c && c != 'l' && c != 'x' {
			out = append(out, "っ")
			i++
			continue
		}
		// longest-match
		matched := false
		hi := maxLen
		if n-i < hi {
			hi = n - i
		}
		for L := hi; L >= 1; L-- {
			seg := s[i : i+L]
			if v, ok := table[seg]; ok {
				out = append(out, v...)
				i += L
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		// 未対応
		unmatched[c]++
		i++
	}
	return out, unmatched
}

// toLowerASCII は ASCII 英字のみ小文字化する(Python の str.lower 相当・ローマ字前提)。
func toLowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}
