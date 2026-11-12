import { describe, expect, it } from "vitest";
import { en } from "../web/src/i18n/en.js";
import { hi } from "../web/src/i18n/hi.js";
import { id } from "../web/src/i18n/id.js";
import { pt } from "../web/src/i18n/pt.js";

// B6.2: the CI check for untranslated text. Every locale has every key, keeps every {placeholder}, and has no value
// left identical to English unless it is a name, a code or a short token that reads the same in that language.
const SAME_OK = /^(Kept|PayPal|MCP|SMS|Telegram|WhatsApp|Email|E-mail|OK|ID|URL|API|AI|PDF|QR|Esc|Alt\+H|px|\d[\d\s.,:%/-]*|[A-Z]{2,5}|[^A-Za-z]*)$/;
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const keys = Object.keys(en) as (keyof typeof en)[];

describe.each([["hi-IN", hi], ["id-ID", id], ["pt-BR", pt]] as const)("%s", (_lang, dict) => {
  it("has every key and nothing extra", () => {
    expect(Object.keys(dict).sort()).toEqual([...keys].sort());
  });
  it("keeps every placeholder", () => {
    const bad = keys.filter((k) => JSON.stringify(ph(dict[k])) !== JSON.stringify(ph(en[k])));
    expect(bad).toEqual([]);
  });
  it("leaves nothing in English by accident", () => {
    const same = keys.filter((k) => dict[k].trim() === en[k].trim() && !SAME_OK.test(en[k].trim()));
    expect(same).toEqual([]);
  });
  it("has no empty values", () => {
    expect(keys.filter((k) => !dict[k].trim())).toEqual([]);
  });
});

it("Hindi is written in Devanagari, not transliterated", () => {
  const prose = keys.filter((k) => /[a-z]{4,}\s+[a-z]{4,}/i.test(en[k]));
  const latinOnly = prose.filter((k) => !/[ऀ-ॿ]/.test(hi[k]));
  expect(latinOnly).toEqual([]);
});
