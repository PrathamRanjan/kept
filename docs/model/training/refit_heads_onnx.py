"""Refit the linear heads on embeddings produced by the quantized ONNX graph itself, so browser and Python agree
exactly. Usage: refit_heads_onnx.py <tag> [quant-dir]. Also re-evaluates and rewrites the parity sample."""
import json, sys, time, numpy as np, onnxruntime as ort
from pathlib import Path
from tokenizers import Tokenizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
tag=sys.argv[1]; qdir=sys.argv[2] if len(sys.argv)>2 else "onnx-int8-pc"; M=Path("models")/tag; P=Path("data/processed")
TACTICS=["impersonation","urgency_secrecy","changed_details","off_platform","gift_cards_crypto","fee_to_release","otp_or_link","overpay_refund","too_good"]
LAB={"genuine":0,"marketing":1,"scam":2}; load=lambda n:[json.loads(l) for l in open(P/f"{n}.jsonl")]
tok=Tokenizer.from_file(str(M/qdir/"tokenizer.json")); tok.enable_truncation(256); tok.no_padding()
sess=ort.InferenceSession(str(M/qdir/"model_quantized.onnx"), providers=["CPUExecutionProvider"])
names={i.name for i in sess.get_inputs()}
def emb(rows, bs=64):
    out=[]
    for i in range(0,len(rows),bs):
        encs=tok.encode_batch([r["text"][:400] for r in rows[i:i+bs]]); L=max(len(e.ids) for e in encs)
        ids=np.zeros((len(encs),L),np.int64); am=np.zeros((len(encs),L),np.int64)
        for j,e in enumerate(encs): ids[j,:len(e.ids)]=e.ids; am[j,:len(e.ids)]=1
        feeds={"input_ids":ids,"attention_mask":am}; 
        if "token_type_ids" in names: feeds["token_type_ids"]=np.zeros_like(ids)
        h=sess.run(None,feeds)[0]; m=am[...,None]; e=(h*m).sum(1)/np.maximum(m.sum(1),1); e/=np.linalg.norm(e,axis=1,keepdims=True)+1e-12; out.append(e.astype(np.float32))
    return np.vstack(out)
t0=time.time(); train=load("train"); Xtr=emb(train); print("embedded train via ONNX in %.0fs"%(time.time()-t0), flush=True)
ytr=np.array([LAB[r["label"]] for r in train]); head=LogisticRegression(max_iter=3000,C=2.0,class_weight="balanced").fit(Xtr,ytr)
tac={}
for t in TACTICS:
    y=np.array([r["tactics"][t] if r["label"]=="scam" else 0 for r in train])
    if y.sum()>=30: tac[t]=LogisticRegression(max_iter=3000,C=1.0,class_weight={0:1.0,1:3.0}).fit(Xtr,y)
val=load("val"); Xv=emb(val); pv=head.predict_proba(Xv)[:,2]; yv=np.array([r["label"]=="scam" for r in val]); g=np.sort(pv[~yv]); thr=float(g[int(0.99*len(g))])
rep={"quant_dir":qdir,"threshold_1pct_genuine_held":thr,"sets":{}}
for n in ["val","test_scamshield86","test_scamshield_evals","test_bec_seed","test_dialogue","test_singlish_genuine","test_business"]:
    rows=val if n=="val" else load(n); X=Xv if n=="val" else emb(rows); p=head.predict_proba(X)[:,2]; y=np.array([r["label"]=="scam" for r in rows]); o={"n":len(rows)}
    if y.any() and (~y).any(): o["auc"]=float(roc_auc_score(y,p))
    if y.any(): o["catch_rate_at_thr"]=float((p[y]>=thr).mean())
    if (~y).any(): o["genuine_held_at_thr"]=float((p[~y]>=thr).mean())
    rep["sets"][n]=o; print(n,o,flush=True)
heads={"label_classes":["genuine","marketing","scam"],"label":{"coef":head.coef_.tolist(),"intercept":head.intercept_.tolist()},"tactics":{t:{"coef":h.coef_[0].tolist(),"intercept":float(h.intercept_[0])} for t,h in tac.items()},"threshold":thr,"normalize":True,"max_chars":400,"fitted_on":"onnx-"+qdir}
json.dump(heads,open(M/"heads.json","w")); sample=load("test_scamshield_evals")[:200]; Xs=emb(sample)
json.dump([{"text":r["text"][:400],"p_scam":float(p)} for r,p in zip(sample,head.predict_proba(Xs)[:,2])],open(M/"parity_sample.json","w"))
json.dump(rep,open(f"reports/text_{tag}_onnxheads.json","w"),indent=1); print("heads refit on ONNX embeddings; done in %.0fs"%(time.time()-t0))
