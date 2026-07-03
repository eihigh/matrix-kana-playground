package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// meta は出力 JSON の meta フィールド。
type meta struct {
	Source       string `json:"source"`
	Note         string `json:"note"`
	CorpusChars  int    `json:"corpusChars"`
	TotalMoras   int    `json:"totalMoras"`
	UnigramTypes int    `json:"unigramTypes"`
	BigramTypes  int    `json:"bigramTypes"`
}

type output struct {
	Meta    meta            `json:"meta"`
	Unigram json.RawMessage `json:"unigram"`
	Bigram  json.RawMessage `json:"bigram"`
}

type kv struct {
	key   string
	count int
}

// orderedObject は頻度降順(同数はキー昇順)に整列した JSON オブジェクトを生成する。
func orderedObject(pairs []kv) json.RawMessage {
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].count != pairs[j].count {
			return pairs[i].count > pairs[j].count
		}
		return pairs[i].key < pairs[j].key
	})
	var b strings.Builder
	b.WriteByte('{')
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte(',')
		}
		kb, _ := json.Marshal(p.key)
		b.Write(kb)
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(p.count))
	}
	b.WriteByte('}')
	return json.RawMessage(b.String())
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ngram <corpus.txt> [out.json]")
		os.Exit(2)
	}
	srcPath := os.Args[1]
	outPath := "../data/ngram_data.json"
	if len(os.Args) > 2 {
		outPath = os.Args[2]
	}

	raw, err := os.ReadFile(srcPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read error:", err)
		os.Exit(1)
	}
	text := string(raw)

	moras, unmatched := RomajiToMoras(text)

	// 検証: 全モーラが かな直 の単位集合に含まれるか
	bad := map[string]int{}
	for _, m := range moras {
		if m != Break && !validUnits[m] {
			bad[m]++
		}
	}

	// 集計
	unigram := map[string]int{}
	bigram := map[string]int{}
	prev := ""
	totalMoras := 0
	for _, m := range moras {
		if m == Break {
			prev = ""
			continue
		}
		unigram[m]++
		totalMoras++
		if prev != "" {
			bigram[prev+"\t"+m]++
		}
		prev = m
	}

	uniPairs := make([]kv, 0, len(unigram))
	for k, c := range unigram {
		uniPairs = append(uniPairs, kv{k, c})
	}
	bigPairs := make([]kv, 0, len(bigram))
	for k, c := range bigram {
		bigPairs = append(bigPairs, kv{k, c})
	}

	corpusChars := utf8.RuneCountInString(text)
	out := output{
		Meta: meta{
			Source: "ローマ字コーパス(" + strconv.Itoa(corpusChars) + "字)をモーラ単位に再構成",
			Note: "くんれい式ベースのローマ字を かな直 専用モーラへ変換し全数集計。" +
				"小書き(ゃゅょ)は基音と結合しモーラ化、外来音(ふぁ・ゔ・てぃ・うぉ等)も専用単位化。" +
				"撥音ん・促音っ・長音ー・句読点(、。)を含む。",
			CorpusChars:  corpusChars,
			TotalMoras:   totalMoras,
			UnigramTypes: len(unigram),
			BigramTypes:  len(bigram),
		},
		Unigram: orderedObject(uniPairs),
		Bigram:  orderedObject(bigPairs),
	}

	buf, err := json.Marshal(out)
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal error:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(outPath, buf, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write error:", err)
		os.Exit(1)
	}

	// レポート
	fmt.Printf("corpus chars : %d\n", corpusChars)
	fmt.Printf("total moras  : %d\n", totalMoras)
	fmt.Printf("unigram types: %d\n", len(unigram))
	fmt.Printf("bigram types : %d\n", len(bigram))
	fmt.Printf("output       : %s\n", outPath)
	if len(unmatched) > 0 {
		fmt.Println("UNMATCHED chars:", topBytes(unmatched, 30))
	}
	if len(bad) > 0 {
		fmt.Println("OUT-OF-SET moras:", topStrings(bad, 30))
	}
	if len(unmatched) == 0 && len(bad) == 0 {
		fmt.Println("OK: 全文字を かな直 単位に変換、集合外モーラ無し。")
	}
}

func topBytes(m map[byte]int, n int) string {
	type e struct {
		k byte
		c int
	}
	es := make([]e, 0, len(m))
	for k, c := range m {
		es = append(es, e{k, c})
	}
	sort.Slice(es, func(i, j int) bool { return es[i].c > es[j].c })
	if len(es) > n {
		es = es[:n]
	}
	parts := make([]string, len(es))
	for i, x := range es {
		parts[i] = fmt.Sprintf("%q:%d", string(x.k), x.c)
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func topStrings(m map[string]int, n int) string {
	es := make([]kv, 0, len(m))
	for k, c := range m {
		es = append(es, kv{k, c})
	}
	sort.Slice(es, func(i, j int) bool { return es[i].count > es[j].count })
	if len(es) > n {
		es = es[:n]
	}
	parts := make([]string, len(es))
	for i, x := range es {
		parts[i] = fmt.Sprintf("%q:%d", x.key, x.count)
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
