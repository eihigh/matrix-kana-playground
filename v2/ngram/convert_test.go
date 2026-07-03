package main

import (
	"reflect"
	"testing"
)

func TestRomajiToMoras(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"単独母音", "aiueo", []string{"あ", "い", "う", "え", "お"}},
		{"基本語", "watasi", []string{"わ", "た", "し"}},
		{"ヘボンshi/chi/tsu", "shichitsu", []string{"し", "ち", "つ"}},
		{"拗音", "kyokan", []string{"きょ", "か", "ん"}},
		{"撥音nn(母音前)", "honnya", []string{"ほ", "ん", "や"}},
		{"撥音n(子音前)", "hondo", []string{"ほ", "ん", "ど"}},
		{"撥音n(語末)", "pan", []string{"ぱ", "ん"}},
		{"な行はんと区別", "nani", []string{"な", "に"}},
		{"促音(子音重ね)", "gakkou", []string{"が", "っ", "こ", "う"}},
		{"促音(ltu)", "altua", []string{"あ", "っ", "あ"}},
		{"外来うぉ", "who", []string{"うぉ"}},
		{"外来ふぁ", "fana", []string{"ふぁ", "な"}},
		{"外来ゔ", "vu", []string{"ゔ"}},
		{"外来てぃ", "thi", []string{"てぃ"}},
		{"分割外来tsa", "tsa", []string{"つ", "ぁ"}},
		{"長音と句読点", "a-,.", []string{"あ", "ー", "、", "。"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, _ := RomajiToMoras(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("RomajiToMoras(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestRomajiToMorasBreak(t *testing.T) {
	got, _ := RomajiToMoras("ka ki")
	want := []string{"か", Break, "き"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRomajiToMorasUppercase(t *testing.T) {
	got, _ := RomajiToMoras("KAki")
	want := []string{"か", "き"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRomajiToMorasUnmatched(t *testing.T) {
	got, unmatched := RomajiToMoras("ka1ki")
	want := []string{"か", "き"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if unmatched['1'] != 1 {
		t.Fatalf("unmatched['1'] = %d, want 1", unmatched['1'])
	}
}

// 全ての変換結果モーラが かな直 の単位集合に含まれることを確認。
func TestAllOutputsAreValidUnits(t *testing.T) {
	sample := "watasihakyoumovaiorinwohiku. gakkoudehonnwoyomu-."
	moras, _ := RomajiToMoras(sample)
	for _, m := range moras {
		if m == Break {
			continue
		}
		if !validUnits[m] {
			t.Errorf("モーラ %q が単位集合に含まれない", m)
		}
	}
}
