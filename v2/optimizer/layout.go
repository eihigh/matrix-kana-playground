// レイアウト表現・かなインベントリ・moraKeys 導出・ngram 読み込み。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// layout.js KANA_LIST(行列に配置しうるモーラ)。
var kanaListBase = []string{
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

var smallYoon = []string{"ゃ", "ゅ", "ょ"}
var smallAll = map[string]bool{
	"ゃ": true, "ゅ": true, "ょ": true,
	"ぁ": true, "ぃ": true, "ぅ": true, "ぇ": true, "ぉ": true,
}

// モーラ分解: しゃ→[し,ゃ]、ふぁ→[ふ,ぁ]。分解対象でなければ nil。
func splitMora(m string) (string, string, bool) {
	r := []rune(m)
	if len(r) == 2 && smallAll[string(r[1])] {
		return string(r[0]), string(r[1]), true
	}
	return "", "", false
}

// ---- モーラインベントリ ----

type moraTable struct {
	names []string
	idx   map[string]int
	// 分解対象モーラの構成単位(基底, 小書き)。対象外は -1。
	base, small []int16
}

func buildMoraTable(extra []string) *moraTable {
	t := &moraTable{idx: map[string]int{}}
	add := func(m string) int {
		if i, ok := t.idx[m]; ok {
			return i
		}
		i := len(t.names)
		t.names = append(t.names, m)
		t.idx[m] = i
		return i
	}
	for _, m := range kanaListBase {
		add(m)
	}
	add("ん")
	add("い")
	for _, m := range smallYoon {
		add(m)
	}
	for _, m := range extra {
		add(m)
	}
	t.base = make([]int16, len(t.names))
	t.small = make([]int16, len(t.names))
	for i, m := range t.names {
		t.base[i], t.small[i] = -1, -1
		if b, s, ok := splitMora(m); ok {
			t.base[i] = int16(t.idx[b])
			t.small[i] = int16(t.idx[s])
		}
	}
	return t
}

// ---- レイアウト(値コピーで snapshot/restore できる固定長表現) ----

type Layout struct {
	isSingle   [nKeys]bool
	singleKana [nKeys]int16 // -1 = 空
	mat        [nKeys * nKeys]int16 // first*20+second → モーラidx / -1 空(単打列は常に -1)
}

func emptyLayout() Layout {
	var l Layout
	for i := range l.singleKana {
		l.singleKana[i] = -1
	}
	for i := range l.mat {
		l.mat[i] = -1
	}
	return l
}

func (l *Layout) singleCount() int {
	n := 0
	for _, s := range l.isSingle {
		if s {
			n++
		}
	}
	return n
}

// 行列スロット一覧(単打キー列を除く)。
func (l *Layout) slots() []int {
	out := make([]int, 0, nKeys*nKeys)
	for f := 0; f < nKeys; f++ {
		if l.isSingle[f] {
			continue
		}
		for s := 0; s < nKeys; s++ {
			out = append(out, f*nKeys+s)
		}
	}
	return out
}

// ---- moraKeys(モーラ→キー列。固定長バッファ) ----

type moraKeysT struct {
	keys   [][4]uint8
	length []uint8
}

func newMoraKeys(n int) *moraKeysT {
	return &moraKeysT{keys: make([][4]uint8, n), length: make([]uint8, n)}
}

// buildMoraKeys は layout.js buildMoraKeys(layout, yoonSplit) と同じ導出。
func buildMoraKeys(l *Layout, mt *moraTable, yoonSplit bool, mk *moraKeysT) {
	for i := range mk.length {
		mk.length[i] = 0
	}
	for slot, kana := range l.mat {
		if kana < 0 {
			continue
		}
		mk.keys[kana][0] = uint8(slot / nKeys)
		mk.keys[kana][1] = uint8(slot % nKeys)
		mk.length[kana] = 2
	}
	for k := 0; k < nKeys; k++ {
		if l.isSingle[k] && l.singleKana[k] >= 0 {
			kana := l.singleKana[k]
			mk.keys[kana][0] = uint8(k)
			mk.length[kana] = 1
		}
	}
	if yoonSplit {
		for i := range mt.names {
			if mt.base[i] < 0 {
				continue
			}
			mk.length[i] = 0 // 配置が残っていても分解合成を優先
			b, s := mt.base[i], mt.small[i]
			lb, ls := mk.length[b], mk.length[s]
			if lb == 0 || ls == 0 {
				continue
			}
			n := uint8(0)
			for j := uint8(0); j < lb; j++ {
				mk.keys[i][n] = mk.keys[b][j]
				n++
			}
			for j := uint8(0); j < ls; j++ {
				mk.keys[i][n] = mk.keys[s][j]
				n++
			}
			mk.length[i] = n
		}
	}
}

// ---- ngram ----

type bigramT struct {
	m1, m2 int32
	freq   float64
}

type ngramData struct {
	bigrams []bigramT
	unigram []float64 // モーラidx → 頻度(分解モードでは単位実効頻度)
}

type ngramJSON struct {
	Unigram map[string]float64 `json:"unigram"`
	Bigram  map[string]float64 `json:"bigram"`
}

func loadNgram(path string, yoonSplit bool) (*moraTable, *ngramData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var nj ngramJSON
	if err := json.Unmarshal(raw, &nj); err != nil {
		return nil, nil, err
	}
	// ngram にしか現れないモーラも登録(配置されないだけでエラーにしない)。
	var extra []string
	for m := range nj.Unigram {
		extra = append(extra, m)
	}
	mt := buildMoraTable(extra)

	ng := &ngramData{unigram: make([]float64, len(mt.names))}
	for m, c := range nj.Unigram {
		i := mt.idx[m]
		if yoonSplit {
			if b, s, ok := splitMora(m); ok {
				ng.unigram[mt.idx[b]] += c
				ng.unigram[mt.idx[s]] += c
				continue
			}
		}
		ng.unigram[i] += c
	}
	for key, c := range nj.Bigram {
		parts := strings.SplitN(key, "\t", 2)
		if len(parts) != 2 {
			return nil, nil, fmt.Errorf("不正な bigram キー: %q", key)
		}
		i1, ok1 := mt.idx[parts[0]]
		i2, ok2 := mt.idx[parts[1]]
		if !ok1 || !ok2 {
			continue
		}
		ng.bigrams = append(ng.bigrams, bigramT{int32(i1), int32(i2), c})
	}
	return mt, ng, nil
}

// ---- レイアウト JSON I/O(アプリのエクスポート形式) ----

type layoutJSON struct {
	Mat    map[string]string `json:"mat"`
	Single map[string]string `json:"single"`
}

func parseLayoutFile(path string, mt *moraTable) (Layout, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Layout{}, err
	}
	var lj layoutJSON
	if err := json.Unmarshal(raw, &lj); err != nil {
		return Layout{}, err
	}
	if lj.Single == nil || len(lj.Single) == 0 {
		return Layout{}, fmt.Errorf("layout JSON に single がありません")
	}
	l := emptyLayout()
	for key, kana := range lj.Single {
		ki, ok := keyIdx[key]
		if !ok {
			return Layout{}, fmt.Errorf("不明な単打キー: %q", key)
		}
		l.isSingle[ki] = true
		if kana != "" {
			if mi, ok := mt.idx[kana]; ok {
				l.singleKana[ki] = int16(mi)
			}
		}
	}
	for slot, kana := range lj.Mat {
		if kana == "" {
			continue
		}
		r := []rune(slot)
		if len(r) != 2 {
			continue
		}
		f, ok1 := keyIdx[string(r[0])]
		s, ok2 := keyIdx[string(r[1])]
		if !ok1 || !ok2 || l.isSingle[f] {
			continue
		}
		if mi, ok := mt.idx[kana]; ok {
			l.mat[f*nKeys+s] = int16(mi)
		}
	}
	return l, nil
}

// 既定レイアウト: KANA_LIST を行列に敷き詰め、F=ん J=い。
func defaultLayout(mt *moraTable) Layout {
	l := emptyLayout()
	fi, ji := keyIdx["F"], keyIdx["J"]
	l.isSingle[fi] = true
	l.isSingle[ji] = true
	l.singleKana[fi] = int16(mt.idx["ん"])
	l.singleKana[ji] = int16(mt.idx["い"])
	slots := l.slots()
	for i, m := range kanaListBase {
		if i >= len(slots) {
			break
		}
		l.mat[slots[i]] = int16(mt.idx[m])
	}
	return l
}

// 分解モードの不変条件を強制: 分解対象モーラを行列・単打から外し、ゃゅょを空きへ配置。
func enforceSplit(l *Layout, mt *moraTable) {
	for slot, kana := range l.mat {
		if kana >= 0 && mt.base[kana] >= 0 {
			l.mat[slot] = -1
		}
	}
	for k := 0; k < nKeys; k++ {
		if l.singleKana[k] >= 0 && mt.base[l.singleKana[k]] >= 0 {
			l.singleKana[k] = -1
		}
	}
	placed := map[int16]bool{}
	for _, kana := range l.mat {
		if kana >= 0 {
			placed[kana] = true
		}
	}
	for k := 0; k < nKeys; k++ {
		if l.singleKana[k] >= 0 {
			placed[l.singleKana[k]] = true
		}
	}
	slots := l.slots()
	for _, sm := range smallYoon {
		mi := int16(mt.idx[sm])
		if placed[mi] {
			continue
		}
		for _, slot := range slots {
			if l.mat[slot] < 0 {
				l.mat[slot] = mi
				placed[mi] = true
				break
			}
		}
	}
}

func writeLayoutJSON(path string, l *Layout, mt *moraTable, m Metrics, cfg *Config) error {
	mat := map[string]string{}
	for f := 0; f < nKeys; f++ {
		if l.isSingle[f] {
			continue
		}
		for s := 0; s < nKeys; s++ {
			kana := ""
			if mi := l.mat[f*nKeys+s]; mi >= 0 {
				kana = mt.names[mi]
			}
			mat[secondKeys[f]+secondKeys[s]] = kana
		}
	}
	single := map[string]string{}
	for k := 0; k < nKeys; k++ {
		if !l.isSingle[k] {
			continue
		}
		kana := ""
		if mi := l.singleKana[k]; mi >= 0 {
			kana = mt.names[mi]
		}
		single[secondKeys[k]] = kana
	}
	out := map[string]any{
		"_meta": map[string]any{
			"name":      "かな直",
			"cost":      m.Cost,
			"effort":    m.Effort,
			"flow":      m.Flow,
			"strokes":   m.Strokes,
			"sfbRate":   m.SfbRate,
			"sfsRate":   m.SfsRate,
			"yoonSplit": cfg.YoonSplit,
			"singles":   l.singleCount(),
			"iters":     cfg.Iters,
			"note":      "go optimizer 出力。アプリの「インポート」で読み込めます(分解モードはアプリ側トグルと合わせる)。",
		},
		"mat":    mat,
		"single": single,
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
