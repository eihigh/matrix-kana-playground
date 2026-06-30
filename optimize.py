#!/usr/bin/env python3
"""
マトリックスかな配列の進化的アルゴリズム最適化。

目的関数(デフォルト):
  - 上段(W E R / U I O)使用率の最小化
  - 指の effort 最小化(弱い指ほど重み大 → pinky < ring < middle/index の荷重順序を誘導)
頻度は ngram_data.json(薙刀式・kouy 100万字統計をモーラ単位に再構成)を使用。

中断耐性:
  - 毎世代 optimize_state.json にアトミック書き出し(再起動で自動レジューム)
  - 最良配列を best_layout.json(playgroundインポート形式)に保存
  - 進捗を optimize_progress.csv に追記
  - SIGINT/SIGTERM でも現世代を保存して終了

使い方:
  python3 optimize.py                 # 既定設定で実行(状態があればレジューム)
  python3 optimize.py --restart       # チェックポイントを無視して最初から
  python3 optimize.py --generations 5000
依存: 標準ライブラリのみ。
"""

import argparse
import csv
import json
import os
import random
import signal
import sys
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

SINGLE_KEYS = ["F", "J", "K"]
SECOND_KEYS = ["W", "E", "R", "A", "S", "D", "F", "U", "I", "O", "J", "K", "L", ";"]
FIRST_KEYS = [k for k in SECOND_KEYS if k not in SINGLE_KEYS]

# 配置すべきモーラ(= タイプ可能にしたいかな全集合)
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
SINGLE_KANA = ["ん", "い", "う"]  # 単打に置きたい高頻度かな(EAは自由に動かす)

# ---------------------------------------------------------------------------
# 目的関数の重み(ここを編集して挙動を調整)
CONFIG = {
    "w_top": 1.0,          # 上段使用率の重み
    "w_effort": 1.0,       # 指effortの重み
    "w_order": 0.0,        # 明示的な順序違反ペナルティ(保険、既定0)
    # 指effort重み: 弱い指ほど大。pinky<ring<middle/index を誘導する。
    "finger_effort": {"LP": 3.0, "LR": 2.0, "LM": 1.0, "LI": 1.0,
                      "RI": 1.0, "RM": 1.0, "RR": 2.0, "RP": 3.0},
    # EAパラメータ
    "pop_size": 120,
    "elite": 6,
    "tournament": 4,
    "mutation_swaps": 3,   # 1個体あたりの最大スワップ回数
    "mutation_rate": 0.9,  # 子に変異を入れる確率
    "local_search_steps": 400,  # エリートに対する山登りステップ数(毎世代)
    "checkpoint_every": 1,      # 何世代ごとに状態を書くか
}


# ---------------------------------------------------------------------------
def build_slots():
    """スロット一覧と、各スロットの (指fid列, 上段キー数, キー数) を返す。"""
    slots = list(SINGLE_KEYS)
    for f in FIRST_KEYS:
        for s in SECOND_KEYS:
            slots.append(f + s)
    slot_fids = []
    slot_top = []
    slot_nkeys = []
    for sid in slots:
        keys = list(sid)  # 1文字(単打) or 2文字
        fids = [FID[KEYMAP[k][1]] for k in keys]
        top = sum(1 for k in keys if KEYMAP[k][2] == "top")
        slot_fids.append(fids)
        slot_top.append(top)
        slot_nkeys.append(len(keys))
    return slots, slot_fids, slot_top, slot_nkeys


def build_items(unigram):
    """配置トークン: モーラ(106種) + 余りは空トークン。各トークンの頻度重みも返す。
    トークンは全て区別される(空も unique)ので、置換交叉(CX)が使える。"""
    morae = KANA_LIST + SINGLE_KANA
    n_slots = len(SLOTS)
    n_empty = n_slots - len(morae)
    if n_empty < 0:
        raise SystemExit("スロット数よりモーラ数が多い")
    items = list(morae) + [None] * n_empty
    weights = [float(unigram.get(m, 0.0)) if m is not None else 0.0 for m in items]
    return items, weights


def fitness(perm, weights, slot_fids, slot_top, slot_nkeys, cfg):
    """perm[slot_index] = token_id。コスト(小さいほど良い)と内訳を返す。"""
    finger = [0.0] * 8
    total = 0.0
    top = 0.0
    for i, tok in enumerate(perm):
        w = weights[tok]
        if w == 0.0:
            continue
        total += w * slot_nkeys[i]
        top += w * slot_top[i]
        for fid in slot_fids[i]:
            finger[fid] += w
    if total <= 0:
        return 1e9, {}
    loads = [finger[i] / total for i in range(8)]
    top_ratio = top / total

    fe = cfg["finger_effort"]
    effort = sum(fe[FINGER_ORDER[i]] * loads[i] for i in range(8))

    # 明示的な順序違反ペナルティ: 各手で pinky<=ring<=avg(mid,index)
    def hand_pen(p, r, m, idx):
        mi = (m + idx) / 2.0
        return max(0.0, p - r) + max(0.0, r - mi)
    order_pen = (hand_pen(loads[FID["LP"]], loads[FID["LR"]], loads[FID["LM"]], loads[FID["LI"]])
                 + hand_pen(loads[FID["RP"]], loads[FID["RR"]], loads[FID["RM"]], loads[FID["RI"]]))

    cost = cfg["w_top"] * top_ratio + cfg["w_effort"] * effort + cfg["w_order"] * order_pen
    comp = {
        "cost": cost,
        "top_ratio": top_ratio,
        "effort": effort,
        "order_pen": order_pen,
        "loads": {FINGER_ORDER[i]: loads[i] for i in range(8)},
    }
    return cost, comp


# ---------------------------------------------------------------------------
def cycle_crossover(p1, p2):
    """順列のサイクル交叉(CX)。p1,p2 は同一トークン集合の順列。"""
    n = len(p1)
    child = [None] * n
    pos2 = {v: i for i, v in enumerate(p2)}
    idx = 0
    use_p1 = True
    visited = [False] * n
    while None in child:
        # 次の未使用開始点
        start = child.index(None)
        i = start
        while not visited[i]:
            visited[i] = True
            child[i] = p1[i] if use_p1 else p2[i]
            i = pos2[p1[i]]
        use_p1 = not use_p1
    return child


def mutate(perm, cfg, rng):
    if rng.random() > cfg["mutation_rate"]:
        return perm
    perm = perm[:]
    n = len(perm)
    swaps = rng.randint(1, cfg["mutation_swaps"])
    for _ in range(swaps):
        a, b = rng.randrange(n), rng.randrange(n)
        perm[a], perm[b] = perm[b], perm[a]
    return perm


def local_search(perm, base_cost, evalf, steps, rng):
    """ランダムスワップ山登り。改善するスワップのみ採用。"""
    n = len(perm)
    cur = perm[:]
    cur_cost = base_cost
    for _ in range(steps):
        a, b = rng.randrange(n), rng.randrange(n)
        if cur[a] == cur[b]:
            continue
        cur[a], cur[b] = cur[b], cur[a]
        c, _comp = evalf(cur)
        if c < cur_cost:
            cur_cost = c
        else:
            cur[a], cur[b] = cur[b], cur[a]  # 戻す
    return cur, cur_cost


# ---------------------------------------------------------------------------
def decode_layout(perm):
    """perm -> playgroundインポート形式 {slotId: kana}。"""
    out = {}
    for i, tok in enumerate(perm):
        m = ITEMS[tok]
        out[SLOTS[i]] = m if m is not None else ""
    return out


def atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def save_checkpoint(generation, population, best_perm, best_cost, best_comp, rng):
    state = {
        "generation": generation,
        "population": population,
        "best_perm": best_perm,
        "best_cost": best_cost,
        "best_comp": best_comp,
        "rng": list(rng.getstate()),
        "n_items": len(ITEMS),
        "n_slots": len(SLOTS),
        "config": CONFIG,
    }
    # rng state: (version, [ints], gauss) — tuple化が必要なので保存時はlist化済み
    state["rng"][1] = list(state["rng"][1])
    atomic_write_json(STATE_PATH, state)


def load_checkpoint():
    if not os.path.exists(STATE_PATH):
        return None
    with open(STATE_PATH, encoding="utf-8") as f:
        st = json.load(f)
    if st.get("n_items") != len(ITEMS) or st.get("n_slots") != len(SLOTS):
        print("チェックポイントのサイズが現データと不一致。最初から開始します。")
        return None
    return st


def restore_rng(rng, rng_state):
    version, intlist, gauss = rng_state
    rng.setstate((version, tuple(intlist), gauss))


def export_best(best_perm, best_comp, generation):
    layout = decode_layout(best_perm)
    payload = {
        "_meta": {
            "generation": generation,
            "cost": best_comp.get("cost"),
            "top_ratio": best_comp.get("top_ratio"),
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
            w.writerow(["generation", "cost", "top_ratio", "effort", "order_pen",
                        *FINGER_ORDER, "elapsed_sec"])
        w.writerow([generation,
                    f"{best_comp['cost']:.6f}",
                    f"{best_comp['top_ratio']:.6f}",
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
    global SLOTS, SLOT_FIDS, SLOT_TOP, SLOT_NKEYS, ITEMS, WEIGHTS

    ap = argparse.ArgumentParser()
    ap.add_argument("--restart", action="store_true", help="チェックポイントを無視して最初から")
    ap.add_argument("--generations", type=int, default=0, help="最大世代数(0=無限)")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    unigram = data["unigram"]

    SLOTS, SLOT_FIDS, SLOT_TOP, SLOT_NKEYS = build_slots()
    ITEMS, WEIGHTS = build_items(unigram)

    cfg = CONFIG
    rng = random.Random(args.seed)

    def evalf(perm):
        return fitness(perm, WEIGHTS, SLOT_FIDS, SLOT_TOP, SLOT_NKEYS, cfg)

    n = len(ITEMS)
    population = None
    generation = 0
    best_perm = None
    best_cost = float("inf")
    best_comp = {}

    if not args.restart:
        st = load_checkpoint()
        if st:
            population = st["population"]
            generation = st["generation"]
            best_perm = st["best_perm"]
            best_cost = st["best_cost"]
            best_comp = st["best_comp"]
            try:
                restore_rng(rng, st["rng"])
            except Exception as e:
                print("RNG復元失敗(無視):", e)
            print(f"レジューム: 世代 {generation}, best_cost={best_cost:.6f}")

    if population is None:
        base = list(range(n))
        population = []
        for _ in range(cfg["pop_size"]):
            p = base[:]
            rng.shuffle(p)
            population.append(p)
        # 初期best
        for p in population:
            c, comp = evalf(p)
            if c < best_cost:
                best_cost, best_comp, best_perm = c, comp, p[:]
        print(f"初期化: pop={cfg['pop_size']}, items={n} (morae+empty), best_cost={best_cost:.6f}")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    t0 = time.time()
    max_gen = args.generations if args.generations > 0 else float("inf")

    # 評価キャッシュ(同一世代内)
    while not STOP and generation < max_gen:
        generation += 1
        scored = [(evalf(p)[0], p) for p in population]
        scored.sort(key=lambda x: x[0])

        elite = [p for _, p in scored[: cfg["elite"]]]
        new_pop = [p[:] for p in elite]

        def tournament():
            best = None
            for _ in range(cfg["tournament"]):
                cand = scored[rng.randrange(len(scored))]
                if best is None or cand[0] < best[0]:
                    best = cand
            return best[1]

        while len(new_pop) < cfg["pop_size"]:
            pa, pb = tournament(), tournament()
            child = cycle_crossover(pa, pb)
            child = mutate(child, cfg, rng)
            new_pop.append(child)

        population = new_pop

        # エリート先頭に局所探索(memetic)
        top_perm = population[0]
        tc, _ = evalf(top_perm)
        improved, ic = local_search(top_perm, tc, evalf, cfg["local_search_steps"], rng)
        population[0] = improved

        # best更新
        c, comp = evalf(population[0])
        for p in population[: cfg["elite"]]:
            cc, cmp2 = evalf(p)
            if cc < c:
                c, comp = cc, cmp2
                population[0] = p
        if c < best_cost:
            best_cost, best_comp, best_perm = c, comp, population[0][:]
            export_best(best_perm, best_comp, generation)

        if generation % cfg["checkpoint_every"] == 0 or STOP:
            save_checkpoint(generation, population, best_perm, best_cost, best_comp, rng)
            append_progress(generation, best_comp, time.time() - t0)

        if generation % 20 == 0 or generation == 1:
            ld = best_comp["loads"]
            print(f"gen {generation:6d} | cost {best_cost:.5f} | top {best_comp['top_ratio']*100:5.2f}% "
                  f"| LP {ld['LP']*100:4.1f} LR {ld['LR']*100:4.1f} LM {ld['LM']*100:4.1f} LI {ld['LI']*100:4.1f} "
                  f"/ RI {ld['RI']*100:4.1f} RM {ld['RM']*100:4.1f} RR {ld['RR']*100:4.1f} RP {ld['RP']*100:4.1f}")

    # 終了時に必ず保存
    save_checkpoint(generation, population, best_perm, best_cost, best_comp, rng)
    export_best(best_perm, best_comp, generation)
    append_progress(generation, best_comp, time.time() - t0)
    print(f"終了: 世代 {generation}, best_cost={best_cost:.6f}")
    print(f"  -> 最良配列: {BEST_PATH} (playgroundにインポート可)")
    print(f"  -> 状態:     {STATE_PATH} (再実行でレジューム)")


if __name__ == "__main__":
    main()
