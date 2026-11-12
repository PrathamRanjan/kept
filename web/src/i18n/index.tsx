/**
 * Part B: the member's flow in four languages. A small in-house layer instead of a library: typed keys (a missing
 * translation fails the build), {name} placeholders, Intl formatting, and a pseudo-locale (?lang=qps) that accents
 * every string and makes it about 30% longer so clipped buttons show up before a real translation does.
 *
 * Choice order: ?lang= in the address, then the choice saved on this device, then the browser's languages, then
 * English. Switching is instant: no reload, and no component is remounted, so half-typed forms keep their text.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { en, type Dict, type Key } from "./en";
import { hi } from "./hi";
import { id } from "./id";
import { pt } from "./pt";

export type Lang = "en" | "hi-IN" | "id-ID" | "pt-BR" | "qps";
export const LANGS: { code: Exclude<Lang, "qps">; name: string }[] = [
  { code: "en", name: "English" },
  { code: "hi-IN", name: "हिन्दी" },
  { code: "id-ID", name: "Bahasa Indonesia" },
  { code: "pt-BR", name: "Português (Brasil)" },
];
const DICTS: Record<Exclude<Lang, "qps">, Dict> = { en, "hi-IN": hi, "id-ID": id, "pt-BR": pt };
/** The tag Intl and <html lang> use. */
export const BCP: Record<Lang, string> = { en: "en-US", "hi-IN": "hi-IN", "id-ID": "id-ID", "pt-BR": "pt-BR", qps: "en-XA" };
const KEY = "kept-lang";

export function normLang(x: unknown): Lang | null {
  const s = String(x ?? "").trim().toLowerCase().replace("_", "-");
  if (!s) return null;
  if (s === "qps" || s === "en-xa") return "qps";
  if (s.startsWith("hi")) return "hi-IN";
  if (s.startsWith("id") || s === "in") return "id-ID";
  if (s.startsWith("pt")) return "pt-BR";
  if (s.startsWith("en")) return "en";
  return null;
}

export function detectLang(): Lang {
  try {
    const q = normLang(new URLSearchParams(location.search).get("lang"));
    if (q) return q;
  } catch { /* no location */ }
  try {
    const saved = normLang(localStorage.getItem(KEY));
    if (saved) return saved;
  } catch { /* storage blocked */ }
  for (const l of (typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [])) {
    const n = normLang(l);
    if (n && n !== "qps") return n;
  }
  return "en";
}

let current: Lang = typeof window === "undefined" ? "en" : detectLang();
/** For code outside React (formatting, the API client). */
export const getLang = () => current;
export const getBcp = () => BCP[current];
/** What the server is told: the pseudo-locale is English to it. */
export const serverLang = () => (current === "qps" ? "en" : current);

const ACCENT: Record<string, string> = { a: "á", e: "é", i: "í", o: "ö", u: "ü", c: "ç", n: "ñ", y: "ý", A: "Å", E: "É", I: "Î", O: "Ö", U: "Ü", C: "Ç", N: "Ñ" };
function pseudo(s: string): string {
  const body = s.replace(/(\{\w+\})|./g, (m, ph) => (ph ? ph : ACCENT[m] ?? m));
  return `[${body}${" ~".repeat(Math.max(1, Math.ceil(s.length * 0.15)))}]`;
}

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const base = lang === "qps" ? pseudo(en[key]) : DICTS[lang][key];
  return vars ? base.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k]))) : base;
}

export type T = (key: Key, vars?: Record<string, string | number>) => string;
interface Ctx { lang: Lang; setLang: (l: Lang) => void; t: T; bcp: string }
const I18n = createContext<Ctx>({ lang: "en", setLang: () => undefined, t: (k, v) => translate("en", k, v), bcp: "en-US" });

function applyDocument(lang: Lang) {
  document.documentElement.lang = BCP[lang];
  document.documentElement.dataset.lang = lang;
  // Noto Sans Devanagari, self-hosted, only when Hindi is chosen (and cached by the browser after that).
  if (lang === "hi-IN") void import("@fontsource/noto-sans-devanagari/400.css").then(() => import("@fontsource/noto-sans-devanagari/600.css")).catch(() => undefined);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  useEffect(() => applyDocument(lang), [lang]);
  const setLang = useCallback((l: Lang) => {
    current = l;
    try {
      if (l !== "qps") localStorage.setItem(KEY, l);
    } catch { /* storage blocked: the choice lasts for this page */ }
    // Keep a ?lang= link honest: if the address names a language, it now names this one.
    const u = new URL(location.href);
    if (u.searchParams.has("lang")) {
      u.searchParams.set("lang", l);
      history.replaceState(history.state, "", u);
    }
    setLangState(l);
    window.dispatchEvent(new CustomEvent("kept:lang", { detail: l }));
  }, []);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (k, v) => translate(lang, k, v), bcp: BCP[lang] }), [lang, setLang]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export const useT = () => useContext(I18n);

/** The header picker: names written in their own language, a native select so it works with every input method. */
export function LangPicker({ className }: { className?: string }) {
  const { lang, setLang, t } = useT();
  return (
    <label className={className}>
      <span className="sr-only">{t("shell.lang")}</span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        className="h-11 max-w-[11rem] rounded-md border border-rule bg-card px-2 text-sm"
        data-testid="lang-picker"
        aria-label={t("shell.lang")}
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code} lang={BCP[l.code]}>{l.name}</option>
        ))}
        {lang === "qps" && <option value="qps">Pseudo (test)</option>}
      </select>
    </label>
  );
}

/** Unit words for a plan's interval ("month", "2 months"), in the chosen language. */
export function everyWords(t: T, unit: string | null | undefined, count: number): string {
  const u = (["DAY", "WEEK", "MONTH", "YEAR"].includes(String(unit).toUpperCase()) ? String(unit).toUpperCase() : "MONTH") as "DAY" | "WEEK" | "MONTH" | "YEAR";
  return count === 1 ? t(`u.${u}.1` as Key) : `${count} ${t(`u.${u}.n` as Key)}`;
}
