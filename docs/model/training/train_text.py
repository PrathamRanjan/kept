"""SetFit fine-tune of MiniLM on scam vs not, then linear heads (3-way label + 9 tactics) on frozen embeddings,
evaluation on every frozen test set, ONNX int8 export of the encoder, JSON export of the heads."""
import json, time, random, sys, os
from pathlib import Path
import numpy as np, torch
from datasets import Dataset
from setfit import SetFitModel, Trainer, TrainingArguments
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, precision_recall_fscore_support
random.seed(7); np.random.seed(7); torch.manual_seed(7)
BASE=sys.argv[1] if len(sys.argv)>1 else "sentence-transformers/all-MiniLM-L6-v2"
TAG=sys.argv[2] if len(sys.argv)>2 else "minilm-l6"
N_FT=int(os.environ.get("N_FT","3000"))
P=Path("data/processed"); M=Path("models")/TAG; M.mkdir(parents=True,exist_ok=True); R=Path("reports"); R.mkdir(exist_ok=True)
TACTICS=["impersonation","urgency_secrecy","changed_details","off_platform","gift_cards_crypto","fee_to_release","otp_or_link","overpay_refund","too_good"]
LAB={"genuine":0,"marketing":1,"scam":2}
load=lambda n:[json.loads(l) for l in open(P/f"{n}.jsonl")]
train,val=load("train"),load("val")
t0=time.time(); log=lambda *a: print(f"[{time.time()-t0:7.1f}s]",*a,flush=True)
# 1. contrastive fine-tune on a balanced sample (scam vs not-scam)
scam=[r for r in train if r["label"]=="scam"]; other=[r for r in train if r["label"]!="scam"]
random.shuffle(scam); random.shuffle(other)
ft=scam[:N_FT//2]+other[:N_FT//2]; random.shuffle(ft)
ds=Dataset.from_dict({"text":[r["text"][:400] for r in ft],"label":[int(r["label"]=="scam") for r in ft]})
model=SetFitModel.from_pretrained(BASE, device="mps")
args=TrainingArguments(batch_size=32, num_epochs=int(os.environ.get("EPOCHS","1")), num_iterations=int(os.environ.get("ITERS","8")), sampling_strategy="oversampling", report_to="none", logging_steps=200)
trainer=Trainer(model=model, args=args, train_dataset=ds)
log("fine-tune start", BASE, "rows", len(ft)); trainer.train(); log("fine-tune done")
enc=model.model_body; enc.save(str(M/"encoder")); log("encoder saved")
# 2. embeddings for everything
def emb(rows): return enc.encode([r["text"][:400] for r in rows], batch_size=128, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)
Xtr=emb(train); log("embedded train", Xtr.shape)
ytr=np.array([LAB[r["label"]] for r in train])
head=LogisticRegression(max_iter=2000, C=2.0, class_weight="balanced").fit(Xtr,ytr)
tac_heads={}
for t in TACTICS:
    y=np.array([r["tactics"][t] if r["label"]=="scam" else 0 for r in train])
    if y.sum()<30: log("skip tactic (too few)",t,int(y.sum())); continue
    tac_heads[t]=LogisticRegression(max_iter=2000, C=1.0, class_weight={0:1.0,1:3.0}).fit(Xtr,y)
log("heads fit")
# 3. evaluate
def p_scam(X): return head.predict_proba(X)[:,LAB["scam"]]
Xv=emb(val); pv=p_scam(Xv); yv=np.array([r["label"]=="scam" for r in val])
# threshold at 1% genuine held on val
gen=np.sort(pv[~yv]); thr=float(gen[int(0.99*len(gen))]) if len(gen) else 0.5
report={"base":BASE,"n_finetune":len(ft),"threshold_1pct_genuine_held":thr,"sets":{}}
def evaluate(name,rows):
    X=emb(rows); p=p_scam(X); y=np.array([r["label"]=="scam" for r in rows])
    out={"n":len(rows)}
    if y.any() and (~y).any(): out["auc"]=float(roc_auc_score(y,p))
    if y.any(): out["catch_rate_at_thr"]=float((p[y]>=thr).mean())
    if (~y).any(): out["genuine_held_at_thr"]=float((p[~y]>=thr).mean())
    report["sets"][name]=out; log(name,out)
    return X
evaluate("val",val)
for n in ["test_scamshield86","test_scamshield_evals","test_bec_seed","test_dialogue","test_singlish_genuine","test_business"]: evaluate(n,load(n))
# tactic quality on the labelled subset of test_scamshield86
ts=[r for r in load("test_scamshield86") if r["label"]=="scam"]; Xt=emb(ts); tq={}
for t,h in tac_heads.items():
    y=np.array([r["tactics"][t] for r in ts]); 
    if y.sum()<10: continue
    pr,rc,f1,_=precision_recall_fscore_support(y,h.predict(Xt),average="binary",zero_division=0)
    prov="labelled" if t in ("impersonation","urgency_secrecy","too_good","fee_to_release") else "weak"
    tq[t]={"precision":float(pr),"recall":float(rc),"f1":float(f1),"positives":int(y.sum()),"label_source":prov}
report["tactics_on_test_scamshield86_scam"]=tq; log("tactics",tq)
# baseline: bag of words
from sklearn.feature_extraction.text import TfidfVectorizer
vec=TfidfVectorizer(ngram_range=(1,2),min_df=3,max_features=60000,sublinear_tf=True).fit([r["text"] for r in train])
bl=LogisticRegression(max_iter=2000,class_weight="balanced").fit(vec.transform([r["text"] for r in train]),(ytr==2).astype(int))
for n in ["test_scamshield_evals","test_bec_seed","test_dialogue"]:
    rows=load(n); y=np.array([r["label"]=="scam" for r in rows]); p=bl.predict_proba(vec.transform([r["text"] for r in rows]))[:,1]
    report["sets"][n]["baseline_tfidf_auc"]=float(roc_auc_score(y,p))
# 4. export heads + encoder ONNX int8
heads={"label_classes":["genuine","marketing","scam"],"label":{"coef":head.coef_.tolist(),"intercept":head.intercept_.tolist()},
       "tactics":{t:{"coef":h.coef_[0].tolist(),"intercept":float(h.intercept_[0])} for t,h in tac_heads.items()},"threshold":thr,"normalize":True,"max_chars":400}
json.dump(heads,open(M/"heads.json","w")); log("heads.json written")
try:
    from optimum.onnxruntime import ORTModelForFeatureExtraction, ORTQuantizer
    from optimum.onnxruntime.configuration import AutoQuantizationConfig
    ort=ORTModelForFeatureExtraction.from_pretrained(str(M/"encoder"), export=True); ort.save_pretrained(str(M/"onnx"))
    q=ORTQuantizer.from_pretrained(str(M/"onnx")); q.quantize(save_dir=str(M/"onnx-int8"), quantization_config=AutoQuantizationConfig.avx512_vnni(is_static=False, per_channel=False))
    import shutil; shutil.copy(M/"encoder"/"tokenizer.json", M/"onnx-int8"/"tokenizer.json") if (M/"encoder"/"tokenizer.json").exists() else None
    sz=sum(f.stat().st_size for f in (M/"onnx-int8").glob("*.onnx"))/1e6; report["onnx_int8_mb"]=round(sz,1); log("onnx int8 exported", sz, "MB")
except Exception as e:
    report["onnx_error"]=repr(e); log("ONNX export failed:", repr(e))
# parity sample for the browser test
sample=load("test_scamshield_evals")[:200]; Xs=emb(sample)
json.dump([{"text":r["text"][:400],"p_scam":float(p)} for r,p in zip(sample,p_scam(Xs))],open(M/"parity_sample.json","w"))
report["train_seconds"]=round(time.time()-t0); json.dump(report,open(R/f"text_{TAG}.json","w"),indent=1); log("done")
