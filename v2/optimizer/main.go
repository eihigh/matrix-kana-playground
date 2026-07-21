// かな直 v2 の CLI 最適化器。JSON 設定でパラメータを渡し、SA(既定20万反復)+
// 貪欲 polish で配列を最適化する。単打キーの位置・割当に加えて「単打数」も
// move(追加/削除)で最適化対象にする。logInterval 反復ごとに effort/flow の推移を出力。
//
// 使い方:
//
//	go run ./v2/optimizer -config config.json
//
// config.json 例:
//
//	{
//	  "ngram": "v2/data/ngram_data.json",
//	  "layout": "start_layout.json",   // 省略時は既定配置(KANA_LIST順)
//	  "weights": { "pen_flow": { "repeat": 4.0 } },  // 部分上書き(省略時アプリ既定)
//	  "iters": 200000,
//	  "yoonSplit": false,
//	  "lockSingle": false,
//	  "varySingles": true,             // 単打数を最適化対象にする
//	  "minSingles": 1, "maxSingles": 8,
//	  "logInterval": 1000,
//	  "seed": 1,
//	  "polish": true,
//	  "out": "optimized_layout.json"
//	}
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
	"runtime"
	"sort"
	"sync"
	"time"
)

type Config struct {
	Ngram  string `json:"ngram"`
	Layout string `json:"layout"`
	// 評価重み。既定値(アプリと同一)の上に JSON の内容だけが上書きされる:
	// スカラーは書いたものだけ、key_effort / pen_flow は書いたキーだけ変わる。
	Weights     Weights `json:"weights"`
	Iters       int     `json:"iters"`
	YoonSplit   bool    `json:"yoonSplit"`
	LockSingle  bool    `json:"lockSingle"`
	VarySingles bool    `json:"varySingles"`
	MinSingles  int     `json:"minSingles"`
	MaxSingles  int     `json:"maxSingles"`
	LogInterval int     `json:"logInterval"`
	Seed        int64   `json:"seed"`
	Polish      *bool   `json:"polish"`
	Out         string  `json:"out"`
	// SA 温度(開始コスト比)。コストのスケールに自動追従する。
	Restarts int     `json:"restarts"` // SAラウンド数。各ラウンドは best から T0→TMIN を冷却し切る。既定 2
	T0Frac   float64 `json:"t0Frac"`   // 既定 0.01
	TMinFrac float64 `json:"tminFrac"` // 既定 0.0001
	// マルチスタート: 乱数の影響を均すため、独立な run を並行実行して最良を採用する。
	Runs    int `json:"runs"`    // 並行シミュレーション数。既定 = CPUコア数
	Workers int `json:"workers"` // 同時実行数。既定 = min(runs, CPUコア数)
}

type optimizer struct {
	cfg     *Config
	mt      *moraTable
	ng      *ngramData
	pen     penTable
	rng     *rand.Rand
	cur     Layout
	curM    Metrics
	best    Layout
	bestM   Metrics
	mk      *moraKeysT
	slots   []int // 現在の行列スロット(単打集合に依存)
	maxFreq float64
	runID   int         // マルチスタートの run 番号(ログ用)
	logMu   *sync.Mutex // 並行 run の stdout ログ排他
}

func (o *optimizer) eval(l *Layout) Metrics {
	buildMoraKeys(l, o.mt, o.cfg.YoonSplit, o.mk)
	return evaluate(o.mk, o.ng, &o.pen, false)
}

func (o *optimizer) evalFull(l *Layout) Metrics {
	buildMoraKeys(l, o.mt, o.cfg.YoonSplit, o.mk)
	return evaluate(o.mk, o.ng, &o.pen, true)
}

func (o *optimizer) syncDerived() {
	o.slots = o.cur.slots()
	o.maxFreq = 1
	for _, slot := range o.slots {
		if kana := o.cur.mat[slot]; kana >= 0 {
			if f := o.ng.unigram[kana]; f > o.maxFreq {
				o.maxFreq = f
			}
		}
	}
}

// 使用頻度に比例した確率でスロットを選ぶ(棄却サンプリング。worker と同じ)。
func (o *optimizer) pickWeightedSlot() int {
	for range 24 {
		slot := o.slots[o.rng.Intn(len(o.slots))]
		kana := o.cur.mat[slot]
		if kana < 0 {
			continue
		}
		f := o.ng.unigram[kana]
		if f <= 0 {
			continue
		}
		if o.rng.Float64() < f/o.maxFreq {
			return slot
		}
	}
	return o.slots[o.rng.Intn(len(o.slots))]
}

func (o *optimizer) singleKeys() []int {
	out := []int{}
	for k := range nKeys {
		if o.cur.isSingle[k] {
			out = append(out, k)
		}
	}
	return out
}

// 1 move を提案し、SA 受理判定する。すべて snapshot/restore 方式(Layout は値型)。
func (o *optimizer) step(temp float64) bool {
	snapshot := o.cur
	structural := false // 単打集合が変わる move か
	p := o.rng.Float64()
	if o.cfg.LockSingle {
		p = 1
	}
	singles := o.singleKeys()

	switch {
	case p < 0.04 && len(singles) >= 2:
		// 単打同士の割当スワップ
		a := singles[o.rng.Intn(len(singles))]
		b := singles[o.rng.Intn(len(singles))]
		if a == b {
			return false
		}
		o.cur.singleKana[a], o.cur.singleKana[b] = o.cur.singleKana[b], o.cur.singleKana[a]
	case p < 0.12 && len(singles) >= 1:
		// 行列かな ⇄ 単打かな
		sk := singles[o.rng.Intn(len(singles))]
		slot := o.pickWeightedSlot()
		if o.cur.mat[slot] < 0 {
			return false
		}
		o.cur.mat[slot], o.cur.singleKana[sk] = o.cur.singleKana[sk], o.cur.mat[slot]
	case p < 0.14 && len(singles) >= 1:
		// 役割スワップ: 単打キー a ⇄ 通常キー b(b 列を a 列へ写す)
		a := singles[o.rng.Intn(len(singles))]
		var firsts []int
		for k := range nKeys {
			if !o.cur.isSingle[k] {
				firsts = append(firsts, k)
			}
		}
		b := firsts[o.rng.Intn(len(firsts))]
		for s := range nKeys {
			o.cur.mat[a*nKeys+s] = o.cur.mat[b*nKeys+s]
			o.cur.mat[b*nKeys+s] = -1
		}
		o.cur.isSingle[a] = false
		o.cur.isSingle[b] = true
		o.cur.singleKana[b] = o.cur.singleKana[a]
		o.cur.singleKana[a] = -1
		structural = true
	case p < 0.17 && o.cfg.VarySingles:
		// 単打数の増減(追加/削除を等確率で提案)
		if o.rng.Intn(2) == 0 {
			if !o.moveAddSingle(singles) {
				return false
			}
		} else {
			if !o.moveRemoveSingle(singles) {
				return false
			}
		}
		structural = true
	default:
		// 行列スワップ(85% は頻度重み付き起点)
		var a int
		if o.rng.Float64() < 0.85 {
			a = o.pickWeightedSlot()
		} else {
			a = o.slots[o.rng.Intn(len(o.slots))]
		}
		b := o.slots[o.rng.Intn(len(o.slots))]
		if a == b || o.cur.mat[a] == o.cur.mat[b] {
			return false
		}
		o.cur.mat[a], o.cur.mat[b] = o.cur.mat[b], o.cur.mat[a]
	}

	if structural {
		o.syncDerived()
	}
	m := o.eval(&o.cur)
	accept := m.Cost <= o.curM.Cost ||
		o.rng.Float64() < math.Exp(-(m.Cost-o.curM.Cost)/math.Max(temp, 1e-9))
	if accept {
		o.curM = m
		if m.Cost < o.bestM.Cost {
			o.best = o.cur
			o.bestM = m
			return true
		}
		return false
	}
	o.cur = snapshot
	if structural {
		o.syncDerived()
	}
	return false
}

// 単打を1つ追加: 通常キー b を単打化し、b 列のかなを空きへ退避、
// 行列から頻度重み付きで選んだかなを新単打へ割り当てる。
func (o *optimizer) moveAddSingle(singles []int) bool {
	if len(singles) >= o.cfg.MaxSingles || len(singles) >= nKeys-1 {
		return false
	}
	var firsts []int
	for k := range nKeys {
		if !o.cur.isSingle[k] {
			firsts = append(firsts, k)
		}
	}
	b := firsts[o.rng.Intn(len(firsts))]
	// 単打に乗せるかな(頻度重み付き)を b 列以外から選ぶ
	var pickSlot = -1
	for range 48 {
		slot := o.pickWeightedSlot()
		if slot/nKeys == b {
			continue
		}
		if o.cur.mat[slot] >= 0 {
			pickSlot = slot
			break
		}
	}
	if pickSlot < 0 {
		return false
	}
	kana := o.cur.mat[pickSlot]
	o.cur.mat[pickSlot] = -1
	// b 列のかなを空きへ退避
	var occupants []int16
	for s := range nKeys {
		if k := o.cur.mat[b*nKeys+s]; k >= 0 {
			occupants = append(occupants, k)
		}
		o.cur.mat[b*nKeys+s] = -1
	}
	o.cur.isSingle[b] = true
	o.cur.singleKana[b] = kana
	if len(occupants) > 0 {
		var empties []int
		for _, slot := range o.cur.slots() {
			if o.cur.mat[slot] < 0 {
				empties = append(empties, slot)
			}
		}
		if len(empties) < len(occupants) {
			return false // 呼び出し側の snapshot で巻き戻る
		}
		o.rng.Shuffle(len(empties), func(i, j int) { empties[i], empties[j] = empties[j], empties[i] })
		for i, k := range occupants {
			o.cur.mat[empties[i]] = k
		}
	}
	return true
}

// 単打を1つ削除: 単打キー a を通常キーへ戻し、かなを空きスロットへ置く。
func (o *optimizer) moveRemoveSingle(singles []int) bool {
	if len(singles) <= o.cfg.MinSingles {
		return false
	}
	a := singles[o.rng.Intn(len(singles))]
	kana := o.cur.singleKana[a]
	o.cur.isSingle[a] = false
	o.cur.singleKana[a] = -1
	if kana >= 0 {
		// a 列が開くので必ず空きがある
		for _, slot := range o.cur.slots() {
			if o.cur.mat[slot] < 0 {
				o.cur.mat[slot] = kana
				break
			}
		}
	}
	return true
}

// SA 本体。温度は開始コスト比で決め(コストスケールに自動追従)、
// 各ラウンドで T0→TMIN まで冷却し切る。ラウンド間は best から再スタート。
// logInterval ごとに effort/flow の推移を出力する。
func (o *optimizer) anneal() {
	interval := o.cfg.LogInterval
	rounds := max(o.cfg.Restarts, 1)
	perRound := max(o.cfg.Iters/rounds, 1)
	o.logLine(0)
	it := 0
	for round := 0; round < rounds; round++ {
		// 各ラウンドは現在の best から。
		o.cur = o.best
		o.curM = o.bestM
		o.syncDerived()
		t0 := o.cfg.T0Frac * o.bestM.Cost
		tmin := o.cfg.TMinFrac * o.bestM.Cost
		cool := math.Pow(tmin/t0, 1/float64(perRound))
		temp := t0
		for i := 0; i < perRound; i++ {
			o.step(temp)
			temp *= cool
			it++
			if it%interval == 0 {
				o.logLine(it)
			}
		}
	}
}

// ログ1行: run 番号・現在コストと、best レイアウトの effort/flow/strokes/単打数。
func (o *optimizer) logLine(iter int) {
	o.logMu.Lock()
	fmt.Printf("%d\t%d\t%.4f\t%.4f\t%.4f\t%.4f\t%.4f\t%d\n",
		o.runID, iter, o.curM.Cost, o.bestM.Cost, o.bestM.Effort, o.bestM.Flow, o.bestM.Strokes, o.best.singleCount())
	o.logMu.Unlock()
}

// polish: 改善が無くなるまで貪欲に詰める。パス数を返す。
// ①各配置かなの全スロット移動/スワップ ②単打割当スワップ ③役割スワップ ④単打数±1。
func (o *optimizer) polish() int {
	o.cur = o.best
	o.curM = o.bestM
	o.syncDerived()
	pass := 0
	for {
		pass++
		improved := false
		// ① 行列: 各かなを全スロットへ(移動 or スワップ)
		for _, from := range o.slots {
			kana := o.cur.mat[from]
			if kana < 0 {
				continue
			}
			bestSlot, bestCost := -1, o.curM.Cost-1e-9
			for _, to := range o.slots {
				if to == from || o.cur.mat[to] == kana {
					continue
				}
				o.cur.mat[from], o.cur.mat[to] = o.cur.mat[to], o.cur.mat[from]
				if m := o.eval(&o.cur); m.Cost < bestCost {
					bestCost, bestSlot = m.Cost, to
				}
				o.cur.mat[from], o.cur.mat[to] = o.cur.mat[to], o.cur.mat[from]
			}
			if bestSlot >= 0 {
				o.cur.mat[from], o.cur.mat[bestSlot] = o.cur.mat[bestSlot], o.cur.mat[from]
				o.curM = o.eval(&o.cur)
				improved = true
			}
		}
		if !o.cfg.LockSingle {
			improved = o.polishSingles() || improved
		}
		if o.curM.Cost < o.bestM.Cost {
			o.best = o.cur
			o.bestM = o.curM
		}
		if !improved {
			return pass
		}
	}
}

func (o *optimizer) polishSingles() bool {
	improved := false
	try := func(apply func() bool) {
		snapshot := o.cur
		if !apply() {
			o.cur = snapshot
			return
		}
		o.syncDerived()
		if m := o.eval(&o.cur); m.Cost < o.curM.Cost-1e-9 {
			o.curM = m
			improved = true
		} else {
			o.cur = snapshot
			o.syncDerived()
		}
	}
	singles := o.singleKeys()
	for _, sk := range singles {
		// ② 単打 ⇄ 行列の割当スワップ
		for _, slot := range o.slots {
			if o.cur.mat[slot] < 0 {
				continue
			}
			slot := slot
			sk := sk
			try(func() bool {
				o.cur.mat[slot], o.cur.singleKana[sk] = o.cur.singleKana[sk], o.cur.mat[slot]
				return true
			})
		}
		// ③ 役割スワップ
		for b := range nKeys {
			if o.cur.isSingle[b] || !o.cur.isSingle[sk] {
				continue
			}
			b := b
			sk := sk
			try(func() bool {
				for s := range nKeys {
					o.cur.mat[sk*nKeys+s] = o.cur.mat[b*nKeys+s]
					o.cur.mat[b*nKeys+s] = -1
				}
				o.cur.isSingle[sk] = false
				o.cur.isSingle[b] = true
				o.cur.singleKana[b] = o.cur.singleKana[sk]
				o.cur.singleKana[sk] = -1
				return true
			})
		}
	}
	// ④ 単打数 ±1(varySingles 時)
	if o.cfg.VarySingles {
		try(func() bool { return o.moveRemoveSingle(o.singleKeys()) })
		try(func() bool { return o.moveAddSingle(o.singleKeys()) })
	}
	return improved
}

func main() {
	configPath := flag.String("config", "", "設定 JSON のパス(必須)")
	flag.Parse()
	if *configPath == "" {
		fmt.Fprintln(os.Stderr, "usage: optimizer -config config.json")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*configPath)
	fatal(err)
	cfg := Config{
		Ngram:       "v2/data/ngram_data.json",
		Weights:     defaultWeights(), // 既定を先に入れておき、JSON の内容だけ上書きさせる
		Iters:       200000,
		MinSingles:  1,
		MaxSingles:  8,
		LogInterval: 1000,
		Seed:        time.Now().UnixNano(),
		Out:         "optimized_layout.json",
		Restarts:    2,
		T0Frac:      0.01,
		TMinFrac:    0.0001,
	}
	fatal(json.Unmarshal(raw, &cfg))
	if cfg.LogInterval <= 0 {
		cfg.LogInterval = 1000
	}

	initKeys()
	initPairs()

	mt, ng, err := loadNgram(cfg.Ngram, cfg.YoonSplit)
	fatal(err)

	var layout Layout
	if cfg.Layout != "" {
		layout, err = parseLayoutFile(cfg.Layout, mt)
		fatal(err)
	} else {
		layout = defaultLayout(mt)
	}
	if cfg.YoonSplit {
		enforceSplit(&layout, mt)
	}

	pen := compileWeights(cfg.Weights)

	// 開始状態の評価(全 run 共通の起点)。
	{
		mk := newMoraKeys(len(mt.names))
		buildMoraKeys(&layout, mt, cfg.YoonSplit, mk)
		m := evaluate(mk, ng, &pen, false)
		fmt.Fprintf(os.Stderr, "開始: cost=%.4f effort=%.4f flow=%.4f strokes=%.4f singles=%d yoonSplit=%v\n",
			m.Cost, m.Effort, m.Flow, m.Strokes, layout.singleCount(), cfg.YoonSplit)
	}

	// マルチスタート: runs 個の独立シミュレーションを並行実行し、最良を採用する。
	runs := cfg.Runs
	if runs <= 0 {
		runs = runtime.NumCPU()
	}
	if cfg.Iters == 0 {
		runs = 1 // 評価のみなら1回で十分
	}
	workers := cfg.Workers
	if workers <= 0 || workers > runtime.NumCPU() {
		workers = runtime.NumCPU()
	}
	if workers > runs {
		workers = runs
	}
	fmt.Fprintf(os.Stderr, "%d run × %d 反復を並行 %d で実行 (seed %d..%d)\n",
		runs, cfg.Iters, workers, cfg.Seed, cfg.Seed+int64(runs)-1)
	fmt.Printf("run\titer\tcurCost\tbestCost\teffort\tflow\tstrokes\tsingles\n")

	type result struct {
		layout Layout
		m      Metrics
	}
	results := make([]result, runs)
	var logMu sync.Mutex
	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	startT := time.Now()
	for i := 0; i < runs; i++ {
		wg.Add(1)
		go func(runID int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			o := &optimizer{
				cfg: &cfg, mt: mt, ng: ng, pen: pen,
				rng:   rand.New(rand.NewSource(cfg.Seed + int64(runID))),
				cur:   layout,
				mk:    newMoraKeys(len(mt.names)),
				runID: runID, logMu: &logMu,
			}
			o.syncDerived()
			o.curM = o.eval(&o.cur)
			o.best = o.cur
			o.bestM = o.curM
			if cfg.Iters > 0 {
				o.anneal()
			}
			passes := 0
			if cfg.Polish == nil || *cfg.Polish {
				passes = o.polish()
			}
			results[runID] = result{o.best, o.bestM}
			fmt.Fprintf(os.Stderr, "run %d 完了: cost=%.4f singles=%d (polish %d パス)\n",
				runID, o.bestM.Cost, o.best.singleCount(), passes)
		}(i)
	}
	wg.Wait()

	// 最良を採用。run 間のばらつきも報告する。
	bestIdx := 0
	costs := make([]float64, runs)
	for i, r := range results {
		costs[i] = r.m.Cost
		if r.m.Cost < results[bestIdx].m.Cost {
			bestIdx = i
		}
	}
	sort.Float64s(costs)
	fmt.Fprintf(os.Stderr, "全 %d run %.1fs: best=%.4f median=%.4f worst=%.4f (採用 run %d)\n",
		runs, time.Since(startT).Seconds(), costs[0], costs[runs/2], costs[runs-1], bestIdx)

	best := results[bestIdx].layout
	mk := newMoraKeys(len(mt.names))
	buildMoraKeys(&best, mt, cfg.YoonSplit, mk)
	finalM := evaluate(mk, ng, &pen, true)
	fmt.Fprintf(os.Stderr, "最終: cost=%.4f effort=%.4f flow=%.4f strokes=%.4f singles=%d\n",
		finalM.Cost, finalM.Effort, finalM.Flow, finalM.Strokes, best.singleCount())
	fmt.Fprintf(os.Stderr, "内訳: sfb=%.3f%% sfs=%.3f%% repeat=%.3f%% badRoll=%.3f%% goodRoll=%.3f%% alt=%.3f%%\n",
		finalM.Rates["sfb"]*100, finalM.Rates["sfs"]*100, finalM.Rates["repeat"]*100,
		finalM.Rates["badRoll"]*100, finalM.Rates["goodRoll"]*100, finalM.Rates["alt"]*100)
	fatal(writeLayoutJSON(cfg.Out, &best, mt, finalM, &cfg))
	fmt.Fprintf(os.Stderr, "出力: %s\n", cfg.Out)
}

func fatal(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
