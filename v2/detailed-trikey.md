# 連接評価精緻化
運指の連続の評価をもっと精緻にする。

## 分類
- good redirect: 良い折り返し
- bad redirect: 悪い折り返し
- good roll: 良いロール
- bad roll: 悪いロール
- それとrepeat, alt, sfb

各bikeyをgood/bad rollとして評価し、方向反転するtrikeyではgood/bad redirectも同時に評価する。
good/bad redirect/roll の4つそれぞれにweightを設定できるようにする。

## roll評価
長い方の指を伸ばすrollはgood roll。人差し指内側絡みはbad roll。人差し指下段絡みは上段と組み合わせるとbad roll。（scissor減点はこのbad roll評価に統合して削除）

具体的なgood rollの組み合わせ: (Home|Bottom|Top)(Index|Middle|Rring|Pinky)
- HI <->     HM, HR, HP,         TM, TR
- HM <-> HI,     HR, HP, BI
- HR <-> HI, HM,     HP, BI,     TM
- HP <-> HI, HM, HR,     BI,     TM, TR
- Top Keys: 上述+Top Row同士
- Bottom Index: 上述

## redirect評価
3キーのどれかにHI, BIキーが含まれる場合はgood redirect。他はbad redirect。

## SFS評価
人差し指の大移動（>1U）だけでなく、=1UのSFSも減点する（距離重みつき）。指標名はSFSとする。
