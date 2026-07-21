// v2/js/metrics.js・layout.js の Go 移植。JS 側と数値が一致するように
// 分類・重み・モーラあたり正規化のロジックをそのまま写している。
package main

import (
	"math"
	"strings"
)

// ---- キー定義(layout.js KEYMAP と同一) ----

// SECOND_KEYS 順のキーインデックス 0..19。
var secondKeys = []string{
	"Q", "W", "E", "R", "A", "S", "D", "F", "V", "G",
	"H", "M", "J", "K", "L", ";", "U", "I", "O", "P",
}

const nKeys = 20

// 指の並び(fid 0..7): LP LR LM LI RI RM RR RP
type keyInfo struct {
	hand       byte // 'L' | 'R'
	fid        int  // 0..7
	fingerKind byte // 'P' 'R' 'M' 'I'
	row        byte // 'T' 'H' 'B'
	x, y       float64
	stretch    bool
}

var keymap [nKeys]keyInfo

func defKey(name, hand string, fid int, kind, row byte, x, y float64, stretch bool) {
	i := keyIdx[name]
	keymap[i] = keyInfo{hand[0], fid, kind, row, x, y, stretch}
}

var keyIdx = map[string]int{}

func initKeys() {
	for i, k := range secondKeys {
		keyIdx[k] = i
	}
	defKey("Q", "L", 0, 'P', 'T', 0, -1, false)
	defKey("W", "L", 1, 'R', 'T', 1, -1, false)
	defKey("E", "L", 2, 'M', 'T', 2, -1, false)
	defKey("R", "L", 3, 'I', 'T', 3, -1, false)
	defKey("A", "L", 0, 'P', 'H', 0, 0, false)
	defKey("S", "L", 1, 'R', 'H', 1, 0, false)
	defKey("D", "L", 2, 'M', 'H', 2, 0, false)
	defKey("F", "L", 3, 'I', 'H', 3, 0, false)
	defKey("G", "L", 3, 'I', 'H', 4, 0, true)
	defKey("V", "L", 3, 'I', 'B', 3, 1, false)
	defKey("U", "R", 4, 'I', 'T', 6, -1, false)
	defKey("I", "R", 5, 'M', 'T', 7, -1, false)
	defKey("O", "R", 6, 'R', 'T', 8, -1, false)
	defKey("P", "R", 7, 'P', 'T', 9, -1, false)
	defKey("H", "R", 4, 'I', 'H', 5, 0, true)
	defKey("J", "R", 4, 'I', 'H', 6, 0, false)
	defKey("K", "R", 5, 'M', 'H', 7, 0, false)
	defKey("L", "R", 6, 'R', 'H', 8, 0, false)
	defKey(";", "R", 7, 'P', 'H', 9, 0, false)
	defKey("M", "R", 4, 'I', 'B', 6, 1, false)
}

// ---- 連接分類テーブル(全キーペアを前計算) ----

const (
	catRepeat = 0
	catSFB    = 1
	catRoll   = 2
	catAlt    = 3
)

var (
	pairCat     [nKeys][nKeys]uint8
	pairDist    [nKeys][nKeys]float64
	rollInward  [nKeys][nKeys]int8 // +1 内向き / -1 外向き(roll のみ有効)
	goodRollTab [nKeys][nKeys]bool
	redirectKey [nKeys]bool // 人差し指ホーム/下段(非ストレッチ) = F V J M
	pinkyKey    [nKeys]bool
)

var goodRollPairs = map[string]bool{}

func positionKind(k keyInfo) string {
	return string(k.row) + string(k.fingerKind)
}

func initPairs() {
	for _, p := range []string{
		"HI:HM", "HI:HR", "HI:HP", "HI:TM", "HI:TR",
		"HM:HR", "HM:HP", "BI:HM",
		"HR:HP", "BI:HR", "HR:TM",
		"BI:HP", "HP:TM", "HP:TR",
	} {
		parts := strings.Split(p, ":")
		if parts[0] > parts[1] {
			parts[0], parts[1] = parts[1], parts[0]
		}
		goodRollPairs[parts[0]+":"+parts[1]] = true
	}
	for a := 0; a < nKeys; a++ {
		ka := keymap[a]
		redirectKey[a] = ka.fingerKind == 'I' && !ka.stretch && (ka.row == 'H' || ka.row == 'B')
		pinkyKey[a] = ka.fingerKind == 'P'
		for b := 0; b < nKeys; b++ {
			kb := keymap[b]
			dx, dy := ka.x-kb.x, ka.y-kb.y
			pairDist[a][b] = math.Sqrt(dx*dx + dy*dy)
			switch {
			case a == b:
				pairCat[a][b] = catRepeat
			case ka.fid == kb.fid:
				pairCat[a][b] = catSFB
			case ka.hand == kb.hand:
				pairCat[a][b] = catRoll
			default:
				pairCat[a][b] = catAlt
			}
			inward := kb.x > ka.x
			if ka.hand == 'R' {
				inward = kb.x < ka.x
			}
			if inward {
				rollInward[a][b] = 1
			} else {
				rollInward[a][b] = -1
			}
			goodRollTab[a][b] = isGoodRoll(a, b)
		}
	}
}

func isGoodRoll(a, b int) bool {
	ka, kb := keymap[a], keymap[b]
	if ka.hand != kb.hand || ka.fid == kb.fid {
		return false
	}
	if (ka.fingerKind == 'I' && ka.stretch) || (kb.fingerKind == 'I' && kb.stretch) {
		return false
	}
	if (ka.fingerKind == 'I' && ka.row == 'B' && kb.row == 'T') ||
		(kb.fingerKind == 'I' && kb.row == 'B' && ka.row == 'T') {
		return false
	}
	if ka.row == 'T' && kb.row == 'T' {
		return true
	}
	pa, pb := positionKind(ka), positionKind(kb)
	if pa > pb {
		pa, pb = pb, pa
	}
	return goodRollPairs[pa+":"+pb]
}

// redirect の3分類インデックス。
const (
	rdIndex  = 0
	rdPinky  = 1
	rdMiddle = 2
)

func redirectCategory(a, b, c int) int {
	if redirectKey[a] || redirectKey[b] || redirectKey[c] {
		return rdIndex
	}
	if pinkyKey[a] || pinkyKey[b] || pinkyKey[c] {
		return rdPinky
	}
	return rdMiddle
}

// ---- 重み ----

type Weights struct {
	WEffort   float64            `json:"w_effort"`
	WOrder    float64            `json:"w_order"`
	WFlow     float64            `json:"w_flow"`
	WStrokes  float64            `json:"w_strokes"`
	KeyEffort map[string]float64 `json:"key_effort"`
	PenFlow   map[string]float64 `json:"pen_flow"`
}

func defaultWeights() Weights {
	return Weights{
		WEffort: 1.0, WOrder: 0.0, WFlow: 1.3, WStrokes: 0.0,
		KeyEffort: map[string]float64{
			"Q": 3.0, "W": 1.45, "E": 1.24, "R": 1.15,
			"A": 1.27, "S": 1.15, "D": 0.94, "F": 0.85, "G": 1.15, "V": 1.15,
			"U": 1.15, "I": 1.15, "O": 1.45, "P": 3.0,
			"H": 1.15, "J": 0.85, "K": 0.85, "L": 1.15, ";": 1.27, "M": 1.15,
		},
		PenFlow: map[string]float64{
			"indexRedirect": 1.1, "pinkyRedirect": 1.5, "middleRedirect": 1.5,
			"goodRoll": 0.0, "badRoll": 1.5, "alt": 0.8,
			"repeat": 3.0, "sfb": 5.0, "sfs": 1.5,
		},
	}
}

// 評価用に展開した重み。
type penTable struct {
	redirect  [3]float64 // index/pinky/middle
	goodRoll  float64
	badRoll   float64
	alt       float64
	repeat    float64
	sfb       float64
	sfs       float64
	keyEffort [nKeys]float64
	wEffort   float64
	wOrder    float64
	wFlow     float64
	wStrokes  float64
}

func compileWeights(w Weights) penTable {
	var p penTable
	p.redirect[rdIndex] = w.PenFlow["indexRedirect"]
	p.redirect[rdPinky] = w.PenFlow["pinkyRedirect"]
	p.redirect[rdMiddle] = w.PenFlow["middleRedirect"]
	p.goodRoll = w.PenFlow["goodRoll"]
	p.badRoll = w.PenFlow["badRoll"]
	p.alt = w.PenFlow["alt"]
	p.repeat = w.PenFlow["repeat"]
	p.sfb = w.PenFlow["sfb"]
	p.sfs = w.PenFlow["sfs"]
	for i, name := range secondKeys {
		p.keyEffort[i] = w.KeyEffort[name]
	}
	p.wEffort = w.WEffort
	p.wOrder = w.WOrder
	p.wFlow = w.WFlow
	p.wStrokes = w.WStrokes
	return p
}

// ---- 指標(metrics.js costFromAcc 相当) ----

type Metrics struct {
	Valid   bool
	Cost    float64
	Effort  float64
	Flow    float64
	Strokes float64
	OrderPen float64
	SfbRate float64 // 距離重み付き / totalBg
	SfsRate float64
	// 内訳(連接あたり): indexRedirect pinkyRedirect middleRedirect goodRoll badRoll alt repeat sfb(件数)
	Rates map[string]float64
}

// evaluate は moraKeys(モーラ→キー列)で全 bigram を評価する。
// second-mora ownership・距離重み付き SFB/SFS・正規化
// (effort/strokes=モーラあたり、flow=連接あたり)は JS と同一。
// wantRates=false なら内訳マップを作らない(SA ホットパス用。アロケーション回避)。
func evaluate(mk *moraKeysT, ng *ngramData, p *penTable, wantRates bool) Metrics {
	var keyCnt [nKeys]float64
	var finger [8]float64
	var total, mora, totalBg, sfbD, sfsD, flowSum float64
	cnt := [8]float64{} // idxRedirect, pinkyRedirect, middleRedirect, goodRoll, badRoll, alt, repeat, sfb
	var run [8]uint8

	for bi := range ng.bigrams {
		bg := &ng.bigrams[bi]
		l1 := mk.length[bg.m1]
		l2 := mk.length[bg.m2]
		if l1 == 0 || l2 == 0 {
			continue
		}
		f := bg.freq
		mora += f
		k1 := mk.keys[bg.m1]
		k2 := mk.keys[bg.m2]
		n := int(l1 + l2)
		copy(run[:l1], k1[:l1])
		copy(run[l1:n], k2[:l2])
		for i := 0; i < int(l2); i++ {
			k := k2[i]
			total += f
			keyCnt[k] += f
			finger[keymap[k].fid] += f
		}
		curDir := int8(0)
		for i := 0; i < n-1; i++ {
			a, b := run[i], run[i+1]
			cat := pairCat[a][b]
			owned := i >= int(l1)-1
			var pen float64
			var cntIdx int
			redirectIdx := -1
			switch cat {
			case catRepeat:
				cntIdx = 6
				pen = p.repeat
				curDir = 0
			case catSFB:
				cntIdx = 7
				curDir = 0
			case catAlt:
				cntIdx = 5
				pen = p.alt
				curDir = 0
			default: // roll
				d := rollInward[a][b]
				if goodRollTab[a][b] {
					cntIdx = 3
					pen = p.goodRoll
				} else {
					cntIdx = 4
					pen = p.badRoll
				}
				if curDir != 0 && d == -curDir {
					redirectIdx = redirectCategory(int(run[i-1]), int(a), int(b))
					pen += p.redirect[redirectIdx]
				}
				curDir = d
			}
			if owned {
				totalBg += f
				cnt[cntIdx] += f
				if redirectIdx >= 0 {
					cnt[redirectIdx] += f
				}
				if cat == catSFB {
					d := pairDist[a][b]
					sfbD += f * d
					flowSum += f * d * p.sfb
				} else {
					flowSum += f * pen
				}
			}
		}
		// same-finger skipgram(1キー飛ばし・距離1以上)。
		for i := 0; i+2 < n; i++ {
			a, c := run[i], run[i+2]
			if keymap[a].fid == keymap[c].fid {
				d := pairDist[a][c]
				if d >= 1 {
					sfsD += f * d
					flowSum += f * d * p.sfs
				}
			}
		}
	}

	if total <= 0 || totalBg <= 0 || mora <= 0 {
		return Metrics{Valid: false, Cost: 1e9}
	}
	effort := 0.0
	for k := 0; k < nKeys; k++ {
		effort += p.keyEffort[k] * keyCnt[k]
	}
	effort /= mora
	flow := flowSum / totalBg // 1連接あたりの質(滑らかさ)。量は effort/strokes が持つ
	strokes := total / mora

	handPen := func(pk, r, m, idx float64) float64 {
		mi := (m + idx) / 2
		return math.Max(0, pk-r) + math.Max(0, r-mi)
	}
	var loads [8]float64
	for i := range finger {
		loads[i] = finger[i] / total
	}
	orderPen := handPen(loads[0], loads[1], loads[2], loads[3]) +
		handPen(loads[7], loads[6], loads[5], loads[4])

	cost := p.wEffort*effort + p.wOrder*orderPen + p.wFlow*flow + p.wStrokes*strokes

	m := Metrics{
		Valid: true, Cost: cost, Effort: effort, Flow: flow, Strokes: strokes,
		OrderPen: orderPen, SfbRate: sfbD / totalBg, SfsRate: sfsD / totalBg,
	}
	if wantRates {
		m.Rates = map[string]float64{
			"indexRedirect": cnt[0] / totalBg, "pinkyRedirect": cnt[1] / totalBg, "middleRedirect": cnt[2] / totalBg,
			"goodRoll": cnt[3] / totalBg, "badRoll": cnt[4] / totalBg, "alt": cnt[5] / totalBg,
			"repeat": cnt[6] / totalBg, "sfbCnt": cnt[7] / totalBg,
			"sfb": sfbD / totalBg, "sfs": sfsD / totalBg,
		}
	}
	return m
}
