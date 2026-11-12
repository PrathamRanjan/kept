"""Builds data/processed/{train,val,test_*}.jsonl from data/raw. One schema:
{text, source, lang, label (scam|marketing|genuine), tactics{9 names: 0/1}, tactic_provenance (labelled|weak|none)}.
Frozen test sets are never merged into train. Dedupe by normalised text across every source."""
import json, re, csv, sys, hashlib, random
from pathlib import Path
import pandas as pd
RAW=Path("data/raw"); OUT=Path("data/processed"); OUT.mkdir(exist_ok=True)
random.seed(7)
TACTICS=["impersonation","urgency_secrecy","changed_details","off_platform","gift_cards_crypto","fee_to_release","otp_or_link","overpay_refund","too_good"]
WEAK={  # regex seeds for tactics the big set does not label
 "changed_details": r"\b(new|updated?|changed?)\b.{0,40}\b(bank|account|acct|iban|beneficiary|payout|payment details|upi id)\b|\b(bank|account) (details|number) (has|have) changed",
 "off_platform": r"\b(whatsapp|telegram|signal|outside (of )?(paypal|the app|platform)|pay (me )?directly|bank transfer instead|cash ?app|zelle|western union|moneygram)\b",
 "gift_cards_crypto": r"\b(gift ?cards?|itunes|google play card|steam card|bitcoin|btc|usdt|crypto|wallet address)\b",
 "fee_to_release": r"\b(processing|release|clearance|delivery|customs|handling|admin|unlock|activation) fee\b|pay .{0,20}\bto (release|claim|unlock|receive)\b",
 "otp_or_link": r"\b(otp|one[- ]time (code|password)|verification code|passcode|pin)\b|https?://|\bclick (here|the link|below)\b|\bbit\.ly\b|\btinyurl\b",
 "overpay_refund": r"\b(over ?pa(id|yment)|sent (you )?too much|refund (the|me the) (difference|extra|excess)|paid extra by mistake)\b",
 "too_good": r"\b(congratulations|you (have )?won|winner|lottery|prize|jackpot|guaranteed (returns?|profit)|double your|free (money|gift|iphone)|100% (profit|return))\b",
 "impersonation": r"\b(officer|police|cbi|irs|hmrc|iras|cpf|dbs|ocbc|uob|paypal (security|team|support)|customs|court|arrest warrant|your (bank|account) (team|officer)|microsoft support|amazon security|from (the )?(government|ministry))\b",
 "urgency_secrecy": r"\b(urgent(ly)?|immediately|within (24|12|48) hours|today only|final (notice|warning)|act now|last chance|do not (tell|share|inform)|keep (this|it) (confidential|secret)|expires? (today|soon|in)|suspended|blocked|blacklist)\b",
}
WEAK_RE={k:re.compile(v,re.I) for k,v in WEAK.items()}
def norm(t): return re.sub(r"\s+"," ",re.sub(r"\d","0",t.lower())).strip()
def weak_tactics(text):
    return {k:int(bool(r.search(text))) for k,r in WEAK_RE.items()}
def row(text, source, lang, label, tactics=None, prov="none"):
    text=str(text).strip()
    if len(text)<3: return None
    t={k:0 for k in TACTICS}
    if tactics: t.update(tactics)
    if label=="scam" and prov!="labelled":
        t.update({k:v for k,v in weak_tactics(text).items()}); prov="weak"
    return {"text":text,"source":source,"lang":lang,"label":label,"tactics":t,"tactic_provenance":prov}
MAP5={"urgency":"urgency_secrecy","fear":"urgency_secrecy","authority_impersonation":"impersonation","reward_bait":"too_good","financial_pressure":"fee_to_release"}
def scamshield86(split):
    out=[]
    for l in open(RAW/f"hf/sidzzz07_scamshield-dataset/{split}.jsonl"):
        r=json.loads(l); h=r.get("head1_social_engineering",{})
        tac={}
        for k,v in h.items():
            if v and k in MAP5: tac[MAP5[k]]=1
        intent=(r.get("head2_scam_intent") or "").lower()
        label="scam" if r["is_scam"] else ("marketing" if "promo" in intent or "marketing" in intent else "genuine")
        if r["is_scam"]:
            w=weak_tactics(r["text"])
            for k in ("changed_details","off_platform","gift_cards_crypto","otp_or_link","overpay_refund"): tac[k]=w[k]
        x=row(r["text"],"scamshield86_"+str(r.get("source_dataset")),r.get("language","English"),label,tac,"labelled" if r["is_scam"] else "none")
        if x: out.append(x)
    return out
train=scamshield86("train")+scamshield86("val"); test_ss86=scamshield86("test")
# UCI
d=pd.read_parquet(RAW/"hf/ucirvine_sms_spam/train-00000-of-00001.parquet")
train+=[x for x in (row(t,"uci_sms","English","marketing" if l==1 else "genuine") for t,l in zip(d.sms,d.label)) if x]
# Indian scam SMS (spam label == scam-ish; keyword labels, treat spam as scam)
d=pd.read_csv(RAW/"hf/anmolshrivastav_scam-ham-india/scam_hum_india.csv")
train+=[x for x in (row(t,"india_sms","English","scam" if l=="spam" else "genuine") for t,l in zip(d.text,d.label)) if x]
# Hinglish
for r in json.load(open(RAW/"hf/bolewara_hinglish-scam-text-dataset/data.json"))["rows"]:
    x=row(r["text"],"hinglish","Hinglish","scam" if r["label"] else "genuine")
    if x: train.append(x)
# Telegram spam (marketing spam, not scam) -- sample 6k to keep balance
d=pd.read_csv(RAW/"hf/thehamkercat_telegram-spam-ham/dataset.csv").sample(6000,random_state=7)
train+=[x for x in (row(t,"telegram","English","marketing" if l=="spam" else "genuine") for t,l in zip(d.text,d.text_type)) if x]
# Phishing emails (truncate to 600 chars) -- sample 6k
d=pd.read_csv(RAW/"hf/zefang-liu_phishing-email-dataset/Phishing_Email.csv").dropna(subset=["Email Text"]).sample(6000,random_state=7)
train+=[x for x in (row(str(t)[:600],"phishing_email","English","scam" if l=="Phishing Email" else "genuine") for t,l in zip(d["Email Text"],d["Email Type"])) if x]
# darkknight BEC seed set -> frozen test
bec=[]
for l in open(RAW/"hf/darkknight25_phishing_benign_email_dataset/phishing%20and%20benign%20email%20dataset.jsonl"):
    r=json.loads(l); x=row(f"{r.get('subject','')}. {r.get('body','')}","bec_seed","English","scam" if r["label"]=="phishing" else "genuine")
    if x: bec.append(x)
# ScamShield eval sets -> frozen tests
ss=[]
for f in (RAW/"scamshield/server/eval").glob("*.json"):
    if "results" in f.name or "ablation" in f.name: continue
    try: items=json.load(open(f))
    except Exception: continue
    if isinstance(items,dict): items=items.get("items") or items.get("cases") or []
    for it in items:
        if not isinstance(it,dict) or "text" not in it: continue
        e=str(it.get("expect") or it.get("label") or "").lower()
        lab="scam" if e in ("scam","block","hold","suspicious") else ("genuine" if e in ("genuine","allow","safe","ham","legit") else None)
        if lab: 
            x=row(it["text"],"scamshield_eval_"+f.stem,"English",lab); 
            if x: ss.append(x)
# dialogue tests (transcripts)
dia=[]
for f in ["BothBosu_scam-dialogue/scam-dialogue_test.csv","BothBosu_multi-agent-scam-conversation/agent_conversation_test.csv"]:
    d=pd.read_csv(RAW/"hf"/f); col="dialogue" if "dialogue" in d.columns else d.columns[0]; lcol="label" if "label" in d.columns else [c for c in d.columns if "label" in c.lower() or c.lower() in ("is_scam","scam")][0]
    dia+=[x for x in (row(str(t)[:800],"dialogue_"+f.split("/")[0],"English","scam" if int(l)==1 else "genuine") for t,l in zip(d[col],d[lcol])) if x]
# dedupe: frozen tests first claim their text, then train drops anything seen
seen=set()
def dedupe(rows):
    out=[]
    for r in rows:
        k=hashlib.md5(norm(r["text"]).encode()).hexdigest()
        if k in seen: continue
        seen.add(k); out.append(r)
    return out
test_ss86=dedupe(test_ss86); ss=dedupe(ss); bec=dedupe(bec); dia=dedupe(dia); train=dedupe(train)
random.shuffle(train); nval=max(2000,len(train)//20); val,train=train[:nval],train[nval:]
def dump(name,rows):
    with open(OUT/f"{name}.jsonl","w") as f:
        for r in rows: f.write(json.dumps(r,ensure_ascii=False)+"\n")
    print(f"{name:22s} {len(rows):7d}  scam={sum(r['label']=='scam' for r in rows):6d} marketing={sum(r['label']=='marketing' for r in rows):6d} genuine={sum(r['label']=='genuine' for r in rows):6d}")
import os
if os.path.exists(OUT/"train_business.jsonl"):
    train+= [json.loads(l) for l in open(OUT/"train_business.jsonl")]; random.shuffle(train)
dump("train",train); dump("val",val); dump("test_scamshield86",test_ss86); dump("test_scamshield_evals",ss); dump("test_bec_seed",bec); dump("test_dialogue",dia)
sing=[r for r in test_ss86 if r["source"].endswith("Smishing_Dataset") and r["label"]=="genuine"][:600]; dump("test_singlish_genuine",sing)
print("business test set kept separately in test_business.jsonl")
