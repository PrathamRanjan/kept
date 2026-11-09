/* Minimal BERT WordPiece tokenizer (uncased) built from tokenizer.json's vocab. No dependencies; same code in browser and Node. */
export function makeTokenizer(tokenizerJson, maxLen = 128) {
  const vocab = tokenizerJson.model.vocab; const unk = vocab["[UNK]"], cls = vocab["[CLS]"], sep = vocab["[SEP]"];
  const isPunct = (c) => /[!-\/:-@\[-`{-~]/.test(c) || /\p{P}/u.test(c);
  function basic(text) {
    const s = text.replace(/[\u0000\uFFFD\p{Cc}\p{Cf}]/gu, "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const out = []; let cur = "";
    for (const ch of s) {
      if (/\s/.test(ch)) { if (cur) out.push(cur), (cur = ""); }
      else if (isPunct(ch) || /\p{Script=Han}/u.test(ch)) { if (cur) out.push(cur), (cur = ""); out.push(ch); }
      else cur += ch;
    }
    if (cur) out.push(cur); return out;
  }
  function wordpiece(word) {
    if (word.length > 100) return [unk];
    const ids = []; let start = 0;
    while (start < word.length) {
      let end = word.length, found = null;
      while (start < end) { const sub = (start ? "##" : "") + word.slice(start, end); if (sub in vocab) { found = vocab[sub]; break; } end--; }
      if (found === null) return [unk];
      ids.push(found); start = end;
    }
    return ids;
  }
  return {
    encode(text) {
      let ids = [cls];
      for (const w of basic(text)) { for (const id of wordpiece(w)) { if (ids.length >= maxLen - 1) break; ids.push(id); } if (ids.length >= maxLen - 1) break; }
      ids.push(sep);
      return { ids, attentionMask: ids.map(() => 1) };
    },
  };
}
