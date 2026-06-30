#!/usr/bin/env python3
"""
マトリックスかな配列の進化的アルゴリズム最適化。

目的(デフォルト):
  - 上段(W E R / U I O)使用率の最小化
  - 指の effort 最小化(弱い指ほど重み大 → pinky < ring < middle/index の荷重順序を誘導)
  - SFB率(同一指で別キーを連打する割合)を上限以下に抑える制約(--sfb-limit, 既定1.0%)

制約:
  - 単打キー F・J・K には う・い・ん の3つのみ配置(3キー間の入れ替えは可、行列側には出ない)

頻度は ngram_data.json(薙刀式・kouy 100万字統計をモーラ単位に再構成)を使用。
SFBは playground と同じく、2打モーラ内部 + モーラ境界のキー連接から算出。

中断耐性:
  - 毎世代 optimize_state.json にアトミック書き出し(再起動で自動レジューム)
  - 最良配列を best_layout.json(playgroundインポート形式)に保存
  - 進捗を optimize_progress.csv に追記
  - SIGINT/SIGTERM でも現世代を保存して終了

使い方:
  python3 optimize.py                       # 既定(SFB上限1.0%)で実行/レジューム
  python3 optimize.py --sfb-limit 1.5       # SFB上限を1.5%に
  python3 optimize.py --restart             # 最初から
  python3 optimize.py --generations 5000    # 世代数を区切る
依存: 標準ライブラリのみ。
"""

import argparse
import csv
import json
import os
import random
import signal
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(HERE, "ngram_data.json")
STATE_PATH = os.path.join(HERE, "optimize_state.json")
BEST_PATH = os.path.join(HERE, "best_layout.json")
PROGRESS_PATH = os.path.join(HERE, "optimize_progress.csv")

# ---------------------------------------------------------------------------
# キー定義(index.html と一致させること)
# fid index: 0=LP 1=LR 2=LM 3=LI 4=RI 5=RM 6=RR 7=RP
FINGER_ORDER = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP"]
FID = {f: i for i, f in enumerate(FINGER_ORDER)}

KEYMAP = {
    "W": ("L", "LR", "top"),
    "E": ("L", "LM", "top"),
    "R": ("L", "LI", "top"),
    "A": ("L", "LP", "home"),
    "S": ("L", "LR", "home"),
    "D": ("L", "LM", "home"),
    "F": ("L", "LI", "home"),
    "U": ("R", "RI", "top"),
    "I": ("R", "RM", "top"),
    "O": ("R", "RR", "top"),
    "J": ("R", "RI", "home"),
    "K": ("R", "RM", "home"),
    "L": ("R", "RR", "home"),
    ";": ("R", "RP", "home"),
}
KEY_FID = {k: FID[v[1]] for k, v in KEYMAP.items()}

SINGLE_KEYS = ["F", "J", "K"]
SECOND_KEYS = ["W", "E", "R", "A", "S", "D", "F", "U", "I", "O", "J", "K", "L", ";"]
FIRST_KEYS = [k for k in SECOND_KEYS if k not in SINGLE_KEYS]

# 行列に配置するモーラ(う・い・ん を除く全集合)
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
    "っ", "ー",
]
# 単打キー(F・J・K)に置けるのはこの3つだけ(3キー間の入れ替えのみ可)
SINGLE_KANA = ["ん", "い", "う"]

# ---------------------------------------------------------------------------
# 目的関数の重み(ここを編集して挙動を調整)
CONFIG = {
    "w_top": 1.0,          # 上段使用率の重み
    "w_effort": 1.0,       # 指effortの重み
    "w_order": 0.0,        # 明示的な順序違反ペナルティ(保険、既定0)
    "sfb_limit": 0.01,     # SFB率の上限(分数)。--sfb-limit で上書き
    "w_sfb_over": 100.0,   # SFB上限超過分のペナルティ重み(制約を実質ハードに)
    # 指effort重み: 弱い指ほど大。pinky<ring<middle/index を誘導する。
    "finger_effort": {"LP": 3.0, "LR": 2.0, "LM": 1.0, "LI": 1.0,
                      "RI": 1.0, "RM": 1.0, "RR": 2.0, "RP": 3.0},
    # EAパラメータ
    "pop_size": 120,
    "elite": 6,
    "tournament": 4,
    "mutation_swaps": 3,        # 行列部の1個体あたり最大スワップ回数
    "mutation_rate": 0.9,       # 子に変異を入れる確率
    "single_mutation_rate": 0.3,  # 単打3キーを入れ替える確率
    "local_search_steps": 500,  # エリートに対する山登りステップ数(毎世代)
    "checkpoint_every": 1,      # 何世代ごとに状態を書くか
}


# ---------------------------------------------------------------------------
# 行列スロット(154) と 単打スロット(3) のプリコンピュート
def build_slots():
    mat_slots = [f + s for f in FIRST_KEYS for s in SECOND_KEYS]
    mat_fids, mat_top, mat_sfb, mat_keys = [], [], [], []
    for sid in mat_slots:
        keys = list(sid)  # 必ず2キー
        f0, f1 = KEY_FID[keys[0]], KEY_FID[keys[1]]
        mat_fids.append((f0, f1))
        mat_top.append(sum(1 for k in keys if KEYMAP[k][2] == "top"))
        mat_sfb.append(f0 == f1 and keys[0] != keys[1])  # 同指・別キー=内部SFB
        mat_keys.append(keys)

    sgl_slots = list(SINGLE_KEYS)
    sgl_fid = [KEY_FID[k] for k in sgl_slots]
    sgl_top = [1 if KEYMAP[k][2] == "top" else 0 for k in sgl_slots]
    sgl_keys = [[k] for k in sgl_slots]
    return (mat_slots, mat_fids, mat_top, mat_sfb, mat_keys,
            sgl_slots, sgl_fid, sgl_top, sgl_keys)


def build_items(unigram):
    n_empty = len(MAT_SLOTS) - len(KANA_LIST)
    if n_empty < 0:
        raise SystemExit("行列スロット数よりモーラ数が多い")
    mat_items = list(KANA_LIST) + [None] * n_empty
    mat_w = [float(unigram.get(m, 0.0)) if m is not None else 0.0 for m in mat_items]
    sgl_items = list(SINGLE_KANA)
    sgl_w = [float(unigram.get(m, 0.0)) for m in sgl_items]
    return mat_items, mat_w, sgl_items, sgl_w


def fitness(genome, cfg):
    """genome = {'mat':[token...], 'sgl':[token...]}。コストと内訳を返す(小さいほど良)。"""
    mat = genome["mat"]
    sgl = genome["sgl"]
    finger = [0.0] * 8
    total = 0.0
    top = 0.0
    total_bg = 0.0
    sfb = 0.0
    mora_keys = {}

    # 行列部: 指/段/effort と 2打モーラ内部バイグラム
    for i, tok in enumerate(mat):
        m = MAT_ITEMS[tok]
        if m is None:
            continue
        mora_keys[m] = MAT_KEYS[i]
        w = MAT_W[tok]
        if w == 0.0:
            continue
        total += w * 2.0
        top += w * MAT_TOP[i]
        f0, f1 = MAT_FIDS[i]
        finger[f0] += w
        finger[f1] += w
        total_bg += w               # 内部キー連接(1モーラ=1回)
        if MAT_SFB[i]:
            sfb += w

    # 単打部: う・い・ん(1キー、ホーム行)
    for i, tok in enumerate(sgl):
        m = SGL_ITEMS[tok]
        mora_keys[m] = SGL_KEYS[i]
        w = SGL_W[tok]
        if w == 0.0:
            continue
        total += w
        top += w * SGL_TOP[i]
        finger[SGL_FID[i]] += w

    # モーラ境界のキー連接(2-gram)
    for m1, m2, f in BIGRAM_LIST:
        k1 = mora_keys.get(m1)
        k2 = mora_keys.get(m2)
        if k1 is None or k2 is None:
            continue
        total_bg += f
        a = k1[-1]
        b = k2[0]
        if KEY_FID[a] == KEY_FID[b] and a != b:
            sfb += f

    if total <= 0 or total_bg <= 0:
        return 1e9, {}

    loads = [finger[i] / total for i in range(8)]
    top_ratio = top / total
    sfb_rate = sfb / total_bg

    fe = cfg["finger_effort"]
    effort = sum(fe[FINGER_ORDER[i]] * loads[i] for i in range(8))

    def hand_pen(p, r, m, idx):
        mi = (m + idx) / 2.0
        return max(0.0, p - r) + max(0.0, r - mi)
    order_pen = (hand_pen(loads[FID["LP"]], loads[FID["LR"]], loads[FID["LM"]], loads[FID["LI"]])
                 + hand_pen(loads[FID["RP"]], loads[FID["RR"]], loads[FID["RM"]], loads[FID["RI"]]))

    sfb_over = max(0.0, sfb_rate - cfg["sfb_limit"])

    cost = (cfg["w_top"] * top_ratio
            + cfg["w_effort"] * effort
            + cfg["w_order"] * order_pen
            + cfg["w_sfb_over"] * sfb_over)
    comp = {
        "cost": cost,
        "top_ratio": top_ratio,
        "effort": effort,
        "order_pen": order_pen,
        "sfb_rate": sfb_rate,
        "loads": {FINGER_ORDER[i]: loads[i] for i in range(8)},
    }
    return cost, comp


# ---------------------------------------------------------------------------
def cycle_crossover(p1, p2):
    """順列のサイクル交叉(CX)。p1,p2 は同一トークン集合の順列。"""
    n = len(p1)
    child = [None] * n
    pos2 = {v: i for i, v in enumerate(p2)}
    use_p1 = True
    visited = [False] * n
    while None in child:
        start = child.index(None)
        i = start
        while not visited[i]:
            visited[i] = True
            child[i] = p1[i] if use_p1 else p2[i]
            i = pos2[p1[i]]
        use_p1 = not use_p1
    return child


def crossover(pa, pb, rng):
    mat = cycle_crossover(pa["mat"], pb["mat"])
    sgl = (pa["sgl"] if rng.random() < 0.5 else pb["sgl"])[:]
    return {"mat": mat, "sgl": sgl}


def mutate(genome, cfg, rng):
    mat = genome["mat"]
    sgl = genome["sgl"]
    if rng.random() <= cfg["mutation_rate"]:
        mat = mat[:]
        n = len(mat)
        for _ in range(rng.randint(1, cfg["mutation_swaps"])):
            a, b = rng.randrange(n), rng.randrange(n)
            mat[a], mat[b] = mat[b], mat[a]
    if rng.random() <= cfg["single_mutation_rate"]:
        sgl = sgl[:]
        a, b = rng.randrange(3), rng.randrange(3)
        sgl[a], sgl[b] = sgl[b], sgl[a]
    return {"mat": mat, "sgl": sgl}


def local_search(genome, base_cost, evalf, steps, rng):
    """ランダムスワップ山登り。行列内/単打内のスワップのみ(境界は越えない)。"""
    cur = {"mat": genome["mat"][:], "sgl": genome["sgl"][:]}
    cur_cost = base_cost
    nmat = len(cur["mat"])
    for _ in range(steps):
        if rng.random() < 0.05:  # 単打3キーの入れ替えを時々試す
            a, b = rng.randrange(3), rng.randrange(3)
            if a == b:
                continue
            cur["sgl"][a], cur["sgl"][b] = cur["sgl"][b], cur["sgl"][a]
            c, _ = evalf(cur)
            if c < cur_cost:
                cur_cost = c
            else:
                cur["sgl"][a], cur["sgl"][b] = cur["sgl"][b], cur["sgl"][a]
        else:
            a, b = rng.randrange(nmat), rng.randrange(nmat)
            if cur["mat"][a] == cur["mat"][b]:
                continue
            cur["mat"][a], cur["mat"][b] = cur["mat"][b], cur["mat"][a]
            c, _ = evalf(cur)
            if c < cur_cost:
                cur_cost = c
            else:
                cur["mat"][a], cur["mat"][b] = cur["mat"][b], cur["mat"][a]
    return cur, cur_cost


# ---------------------------------------------------------------------------
def decode_layout(genome):
    out = {}
    for i, tok in enumerate(genome["mat"]):
        m = MAT_ITEMS[tok]
        out[MAT_SLOTS[i]] = m if m is not None else ""
    for i, tok in enumerate(genome["sgl"]):
        out[SGL_SLOTS[i]] = SGL_ITEMS[tok]
    return out


def atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def save_checkpoint(generation, population, best_genome, best_cost, best_comp, rng, cfg):
    rng_state = list(rng.getstate())
    rng_state[1] = list(rng_state[1])
    state = {
        "generation": generation,
        "population": population,
        "best_genome": best_genome,
        "best_cost": best_cost,
        "best_comp": best_comp,
        "rng": rng_state,
        "n_mat": len(MAT_SLOTS),
        "n_sgl": len(SGL_SLOTS),
        "sfb_limit": cfg["sfb_limit"],
    }
    atomic_write_json(STATE_PATH, state)


def load_checkpoint():
    if not os.path.exists(STATE_PATH):
        return None
    with open(STATE_PATH, encoding="utf-8") as f:
        st = json.load(f)
    if st.get("n_mat") != len(MAT_SLOTS) or st.get("n_sgl") != len(SGL_SLOTS):
        print("チェックポイントのサイズが現データと不一致。最初から開始します。")
        return None
    return st


def restore_rng(rng, rng_state):
    version, intlist, gauss = rng_state
    rng.setstate((version, tuple(intlist), gauss))


def export_best(best_genome, best_comp, generation, cfg):
    layout = decode_layout(best_genome)
    payload = {
        "_meta": {
            "generation": generation,
            "cost": best_comp.get("cost"),
            "top_ratio": best_comp.get("top_ratio"),
            "sfb_rate": best_comp.get("sfb_rate"),
            "sfb_limit": cfg["sfb_limit"],
            "effort": best_comp.get("effort"),
            "loads": best_comp.get("loads"),
            "note": "playgroundの『インポート』に読み込める形式(_metaは無視される)",
        },
    }
    payload.update(layout)
    atomic_write_json(BEST_PATH, payload)


def append_progress(generation, best_comp, elapsed):
    new = not os.path.exists(PROGRESS_PATH)
    loads = best_comp.get("loads", {})
    with open(PROGRESS_PATH, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["generation", "cost", "top_ratio", "sfb_rate", "effort", "order_pen",
                        *FINGER_ORDER, "elapsed_sec"])
        w.writerow([generation,
                    f"{best_comp['cost']:.6f}",
                    f"{best_comp['top_ratio']:.6f}",
                    f"{best_comp['sfb_rate']:.6f}",
                    f"{best_comp['effort']:.6f}",
                    f"{best_comp['order_pen']:.6f}",
                    *[f"{loads.get(fk, 0):.4f}" for fk in FINGER_ORDER],
                    f"{elapsed:.1f}"])


# ---------------------------------------------------------------------------
STOP = False


def handle_signal(signum, frame):
    global STOP
    STOP = True
    print(f"\nシグナル {signum} 受信。現世代を保存して終了します…")


def main():
    global MAT_SLOTS, MAT_FIDS, MAT_TOP, MAT_SFB, MAT_KEYS
    global SGL_SLOTS, SGL_FID, SGL_TOP, SGL_KEYS
    global MAT_ITEMS, MAT_W, SGL_ITEMS, SGL_W, BIGRAM_LIST

    ap = argparse.ArgumentParser()
    ap.add_argument("--restart", action="store_true", help="チェックポイントを無視して最初から")
    ap.add_argument("--generations", type=int, default=0, help="最大世代数(0=無限)")
    ap.add_argument("--sfb-limit", type=float, default=1.0, help="SFB率の上限(%%表記、既定1.0)")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    unigram = data["unigram"]
    BIGRAM_LIST = []
    for key, fr in data["bigram"].items():
        m1, m2 = key.split("\t")
        BIGRAM_LIST.append((m1, m2, float(fr)))

    (MAT_SLOTS, MAT_FIDS, MAT_TOP, MAT_SFB, MAT_KEYS,
     SGL_SLOTS, SGL_FID, SGL_TOP, SGL_KEYS) = build_slots()
    MAT_ITEMS, MAT_W, SGL_ITEMS, SGL_W = build_items(unigram)

    cfg = dict(CONFIG)
    cfg["sfb_limit"] = args.sfb_limit / 100.0
    rng = random.Random(args.seed)

    def evalf(g):
        return fitness(g, cfg)

    nmat = len(MAT_ITEMS)
    population = None
    generation = 0
    best_genome = None
    best_cost = float("inf")
    best_comp = {}

    if not args.restart:
        st = load_checkpoint()
        if st:
            population = st["population"]
            generation = st["generation"]
            best_genome = st["best_genome"]
            best_cost = st["best_cost"]
            best_comp = st["best_comp"]
            try:
                restore_rng(rng, st["rng"])
            except Exception as e:
                print("RNG復元失敗(無視):", e)
            print(f"レジューム: 世代 {generation}, best_cost={best_cost:.6f}, SFB上限={cfg['sfb_limit']*100:.2f}%")

    if population is None:
        base_mat = list(range(nmat))
        population = []
        for _ in range(cfg["pop_size"]):
            mp = base_mat[:]
            rng.shuffle(mp)
            sp = [0, 1, 2]
            rng.shuffle(sp)
            population.append({"mat": mp, "sgl": sp})
        for g in population:
            c, comp = evalf(g)
            if c < best_cost:
                best_cost, best_comp, best_genome = c, comp, {"mat": g["mat"][:], "sgl": g["sgl"][:]}
        print(f"初期化: pop={cfg['pop_size']}, 行列={nmat}items, 単打=う・い・ん, "
              f"SFB上限={cfg['sfb_limit']*100:.2f}%, best_cost={best_cost:.6f}")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    t0 = time.time()
    max_gen = args.generations if args.generations > 0 else float("inf")

    while not STOP and generation < max_gen:
        generation += 1
        scored = [(evalf(g)[0], g) for g in population]
        scored.sort(key=lambda x: x[0])

        elite = [g for _, g in scored[: cfg["elite"]]]
        new_pop = [{"mat": g["mat"][:], "sgl": g["sgl"][:]} for g in elite]

        def tournament():
            best = None
            for _ in range(cfg["tournament"]):
                cand = scored[rng.randrange(len(scored))]
                if best is None or cand[0] < best[0]:
                    best = cand
            return best[1]

        while len(new_pop) < cfg["pop_size"]:
            child = crossover(tournament(), tournament(), rng)
            child = mutate(child, cfg, rng)
            new_pop.append(child)

        population = new_pop

        # エリート先頭に局所探索(memetic)
        tc, _ = evalf(population[0])
        improved, _ic = local_search(population[0], tc, evalf, cfg["local_search_steps"], rng)
        population[0] = improved

        # best更新
        c, comp = evalf(population[0])
        for g in population[: cfg["elite"]]:
            cc, cmp2 = evalf(g)
            if cc < c:
                c, comp, population[0] = cc, cmp2, g
        if c < best_cost:
            best_cost, best_comp = c, comp
            best_genome = {"mat": population[0]["mat"][:], "sgl": population[0]["sgl"][:]}
            export_best(best_genome, best_comp, generation, cfg)

        if generation % cfg["checkpoint_every"] == 0 or STOP:
            save_checkpoint(generation, population, best_genome, best_cost, best_comp, rng, cfg)
            append_progress(generation, best_comp, time.time() - t0)

        if generation % 20 == 0 or generation == 1:
            ld = best_comp["loads"]
            print(f"gen {generation:6d} | cost {best_cost:.5f} | top {best_comp['top_ratio']*100:5.2f}% "
                  f"| SFB {best_comp['sfb_rate']*100:4.2f}% "
                  f"| LP {ld['LP']*100:4.1f} LR {ld['LR']*100:4.1f} LM {ld['LM']*100:4.1f} LI {ld['LI']*100:4.1f} "
                  f"/ RI {ld['RI']*100:4.1f} RM {ld['RM']*100:4.1f} RR {ld['RR']*100:4.1f} RP {ld['RP']*100:4.1f}")

    save_checkpoint(generation, population, best_genome, best_cost, best_comp, rng, cfg)
    export_best(best_genome, best_comp, generation, cfg)
    append_progress(generation, best_comp, time.time() - t0)
    print(f"終了: 世代 {generation}, best_cost={best_cost:.6f}, "
          f"top={best_comp['top_ratio']*100:.2f}%, SFB={best_comp['sfb_rate']*100:.2f}%")
    print(f"  -> 最良配列: {BEST_PATH} (playgroundにインポート可)")
    print(f"  -> 状態:     {STATE_PATH} (再実行でレジューム)")


if __name__ == "__main__":
    main()
