#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ローマ字コーパスを Matrix Kana 専用 n-gram データに変換する。

入力: くんれい式ベースのローマ字テキスト
  - youon は sh/ty/j 等ヘボン混在、外来音は f/v/th/dh/ts、小書きは l/x 接頭。
  - 長音は "-"(→ー)、句読点は ","(→、) "."(→。)。
  - 撥音 ん は "nn"(母音/y の前) もしくは "n"(子音・語末)。
  - 促音 っ は子音重ね、または ltu/xtu/ltsu/xtsu。
出力: ngram_data.json と同形式(meta / unigram / bigram)。
      モーラ単位は optimize.py の KANA_LIST + SINGLE_KANA に一致させる。
"""
import json
import os
import sys
import collections

HERE = os.path.dirname(os.path.abspath(__file__))

# Matrix Kana が扱うモーラ単位の集合(optimize.py と一致させる)
KANA_LIST = [
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
    "ゔぁ", "ゔぃ", "ゔ", "ゔぇ", "ゔぉ",
    "てぃ", "でぃ", "しぇ", "じぇ", "ちぇ",
    "ぁ", "ぃ", "ぅ", "ぇ", "ぉ",
    "っ", "ー", "、", "。",
]
SINGLE_KANA = ["ん", "い", "う"]
VALID_UNITS = set(KANA_LIST) | set(SINGLE_KANA)

VOWELS = set("aiueo")
# 促音を生む子音(n は撥音なので除外)
SOKUON_CONS = set("kgsztdhbpmyrwfvjc")

# ローマ字 → モーラ列(longest-match 用テーブル)。値は1個以上のモーラ。
TABLE = {
    # 単独母音
    "a": ["あ"], "i": ["い"], "u": ["う"], "e": ["え"], "o": ["お"],
    # か行/が行
    "ka": ["か"], "ki": ["き"], "ku": ["く"], "ke": ["け"], "ko": ["こ"],
    "ga": ["が"], "gi": ["ぎ"], "gu": ["ぐ"], "ge": ["げ"], "go": ["ご"],
    # さ行(くんれい si / ヘボン shi 両対応)
    "sa": ["さ"], "si": ["し"], "shi": ["し"], "su": ["す"], "se": ["せ"], "so": ["そ"],
    "za": ["ざ"], "zi": ["じ"], "ji": ["じ"], "zu": ["ず"], "ze": ["ぜ"], "zo": ["ぞ"],
    # た行(くんれい ti/tu/di/du、ヘボン chi/tsu 両対応)
    "ta": ["た"], "ti": ["ち"], "chi": ["ち"], "tu": ["つ"], "tsu": ["つ"],
    "te": ["て"], "to": ["と"],
    "da": ["だ"], "di": ["ぢ"], "du": ["づ"], "de": ["で"], "do": ["ど"],
    # な行
    "na": ["な"], "ni": ["に"], "nu": ["ぬ"], "ne": ["ね"], "no": ["の"],
    # は行(くんれい hu / ヘボン fu)
    "ha": ["は"], "hi": ["ひ"], "hu": ["ふ"], "fu": ["ふ"], "he": ["へ"], "ho": ["ほ"],
    "ba": ["ば"], "bi": ["び"], "bu": ["ぶ"], "be": ["べ"], "bo": ["ぼ"],
    "pa": ["ぱ"], "pi": ["ぴ"], "pu": ["ぷ"], "pe": ["ぺ"], "po": ["ぽ"],
    # ま行
    "ma": ["ま"], "mi": ["み"], "mu": ["む"], "me": ["め"], "mo": ["も"],
    # や行
    "ya": ["や"], "yu": ["ゆ"], "yo": ["よ"],
    # ら行
    "ra": ["ら"], "ri": ["り"], "ru": ["る"], "re": ["れ"], "ro": ["ろ"],
    # わ行
    "wa": ["わ"], "wo": ["を"],
    # --- 拗音(1モーラに結合) ---
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
    # --- 外来音(Matrix の専用ユニット) ---
    "fa": ["ふぁ"], "fi": ["ふぃ"], "fe": ["ふぇ"], "fo": ["ふぉ"],
    "va": ["ゔぁ"], "vi": ["ゔぃ"], "vu": ["ゔ"], "ve": ["ゔぇ"], "vo": ["ゔぉ"],
    "thi": ["てぃ"], "dhi": ["でぃ"],
    "she": ["しぇ"], "je": ["じぇ"], "che": ["ちぇ"], "tye": ["ちぇ"],
    # --- 外来音(専用ユニットが無く 基音+小書き に分割) ---
    "tsa": ["つ", "ぁ"], "tsi": ["つ", "ぃ"], "tse": ["つ", "ぇ"], "tso": ["つ", "ぉ"],
    "wi": ["う", "ぃ"], "we": ["う", "ぇ"],
    "wha": ["う", "ぁ"], "whi": ["う", "ぃ"], "whu": ["う"],
    "whe": ["う", "ぇ"], "who": ["う", "ぉ"],
    "ye": ["い", "ぇ"],
    # --- 小書き単独(ワープロ式 l/x 接頭) ---
    "la": ["ぁ"], "li": ["ぃ"], "lu": ["ぅ"], "le": ["ぇ"], "lo": ["ぉ"],
    "xa": ["ぁ"], "xi": ["ぃ"], "xu": ["ぅ"], "xe": ["ぇ"], "xo": ["ぉ"],
    "lya": ["ゃ"], "lyu": ["ゅ"], "lyo": ["ょ"],
    "xya": ["ゃ"], "xyu": ["ゅ"], "xyo": ["ょ"],
    "ltu": ["っ"], "xtu": ["っ"], "ltsu": ["っ"], "xtsu": ["っ"],
    # 記号
    "-": ["ー"], ",": ["、"], ".": ["。"],
}

MAXLEN = max(len(k) for k in TABLE)
BREAK = "\x00"  # 空白(語境界)。bigram を跨がせないためのマーカー。


def romaji_to_moras(text):
    """ローマ字文字列をモーラ列に変換。空白は BREAK で区切る。"""
    s = text.lower()
    n = len(s)
    out = []
    unmatched = collections.Counter()
    i = 0
    while i < n:
        c = s[i]
        # 空白 → 語境界
        if c == " " or c == "\n" or c == "\t" or c == "\r":
            out.append(BREAK)
            i += 1
            continue
        # 撥音 ん
        if c == "n":
            nxt = s[i + 1] if i + 1 < n else ""
            if nxt == "n":
                out.append("ん")
                i += 2
                continue
            if nxt in VOWELS or nxt == "y":
                pass  # な行/にゃ行として下のテーブル照合に回す
            else:
                out.append("ん")
                i += 1
                continue
        # 促音(子音重ね)。l/x 接頭の促音はテーブル側(ltu 等)で処理。
        if c in SOKUON_CONS and c != "n" and i + 1 < n and s[i + 1] == c \
                and c not in ("l", "x"):
            out.append("っ")
            i += 1
            continue
        # longest-match
        matched = False
        for L in range(min(MAXLEN, n - i), 0, -1):
            seg = s[i:i + L]
            if seg in TABLE:
                out.extend(TABLE[seg])
                i += L
                matched = True
                break
        if matched:
            continue
        # 未対応
        unmatched[c] += 1
        i += 1
    return out, unmatched


def main():
    src_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not src_path:
        sys.exit("usage: build_ngram.py <corpus.txt> [out.json]")
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "ngram_data.json")
    text = open(src_path, encoding="utf-8").read()

    moras, unmatched = romaji_to_moras(text)

    # 検証: 全モーラが Matrix の単位集合に含まれるか
    bad = collections.Counter()
    for m in moras:
        if m != BREAK and m not in VALID_UNITS:
            bad[m] += 1

    # 集計
    unigram = collections.Counter()
    bigram = collections.Counter()
    prev = None
    total_moras = 0
    for m in moras:
        if m == BREAK:
            prev = None
            continue
        unigram[m] += 1
        total_moras += 1
        if prev is not None:
            bigram[(prev, m)] += 1
        prev = m

    # 出力(unigram は頻度降順、bigram も降順)
    uni_sorted = dict(sorted(unigram.items(), key=lambda kv: -kv[1]))
    big_sorted = {f"{a}\t{b}": c
                  for (a, b), c in sorted(bigram.items(), key=lambda kv: -kv[1])}

    data = {
        "meta": {
            "source": "ローマ字コーパス(998,589字)をモーラ単位に再構成",
            "note": "くんれい式ベースのローマ字を Matrix Kana 専用モーラへ変換し全数集計。"
                    "小書き(ゃゅょ)は基音と結合しモーラ化、外来音(ふぁ・ゔ・てぃ等)も専用単位化。"
                    "撥音ん・促音っ・長音ー・句読点(、。)を含む。",
            "corpusChars": len(text),
            "totalMoras": total_moras,
            "unigramTypes": len(unigram),
            "bigramTypes": len(bigram),
        },
        "unigram": uni_sorted,
        "bigram": big_sorted,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    # レポート
    print(f"corpus chars : {len(text)}")
    print(f"total moras  : {total_moras}")
    print(f"unigram types: {len(unigram)}")
    print(f"bigram types : {len(bigram)}")
    print(f"output       : {out_path}")
    if unmatched:
        print("UNMATCHED chars:", dict(unmatched.most_common(30)))
    if bad:
        print("OUT-OF-SET moras:", dict(bad.most_common(30)))
    if not unmatched and not bad:
        print("OK: 全文字を Matrix 単位に変換、集合外モーラ無し。")


if __name__ == "__main__":
    main()
