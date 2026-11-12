"""Synthetic payment-risk model: generator calibrated to the FTC/FBI-derived scenario mix used by Legacy Protection,
LightGBM with monotone constraints (scam signals can only raise risk), exported to JSON for a JS tree walker.
Every number produced here is synthetic and must be labelled as such wherever shown."""
import json, numpy as np, time
from pathlib import Path
import lightgbm as lgb
from sklearn.metrics import roc_auc_score
rng=np.random.default_rng(7); M=Path("models/risk"); M.mkdir(parents=True,exist_ok=True)
FEATS=["amount_ratio_to_history","payee_age_days","details_changed_recently","request_channel_untrusted","hour_local","velocity_10m","velocity_24h_sum_ratio","method_new","t_impersonation","t_urgency","t_changed_details","t_off_platform","t_gift_crypto","t_fee","t_otp_link","t_overpay","t_too_good"]
MONO=[1,-1,1,1,0,1,1,1,1,1,1,1,1,1,1,1,1]
def gen(n, scam):
    """Overlapping distributions: most scams look ordinary on any single feature; the signal is the combination."""
    X=np.zeros((n,len(FEATS)))
    hard=rng.random(n)<(0.5 if scam else 0.0)                      # half the scams hide one or more signals
    X[:,0]=rng.lognormal(np.where(scam, np.where(hard,0.2,0.9), 0.0), 0.7, n)
    X[:,1]=rng.exponential(np.where(scam, np.where(hard,120,8), 180), n)
    X[:,2]=rng.random(n)<np.where(scam, np.where(hard,0.12,0.4), 0.04)
    X[:,3]=rng.random(n)<np.where(scam, np.where(hard,0.25,0.55), 0.12)
    X[:,4]=rng.integers(0,24,n)
    X[:,5]=rng.poisson(np.where(scam, np.where(hard,0.4,1.2), 0.25), n)
    X[:,6]=rng.lognormal(np.where(scam, np.where(hard,0.1,0.6), 0.0), 0.5, n)
    X[:,7]=rng.random(n)<np.where(scam, np.where(hard,0.15,0.4), 0.08)
    for j in range(8,17):
        on=rng.random(n)<np.where(scam, np.where(hard,0.15,0.35), 0.06)   # a tactic fires on only some messages
        X[:,j]=np.clip(np.where(on, rng.beta(4,2,n), rng.beta(1,8,n)),0,1)
    return X
Xs,Xg=gen(20000,True),gen(80000,False); X=np.vstack([Xs,Xg]); y=np.r_[np.ones(len(Xs)),np.zeros(len(Xg))]
idx=rng.permutation(len(y)); X,y=X[idx],y[idx]; n=int(0.8*len(y))
m=lgb.LGBMClassifier(n_estimators=300,learning_rate=0.05,num_leaves=15,monotone_constraints=MONO,monotone_constraints_method="advanced",verbose=-1).fit(X[:n],y[:n])
p=m.predict_proba(X[n:])[:,1]; auc=roc_auc_score(y[n:],p)
dump=m.booster_.dump_model(); json.dump({"features":FEATS,"monotone":MONO,"model":dump,"note":"SYNTHETIC training data; numbers are not measured fraud performance"},open(M/"risk_lgbm.json","w"))
# monotonicity probe: raising a scam tactic must never lower the score
probe=X[n:n+500].copy(); p0=m.predict_proba(probe)[:,1]; probe[:,8]=np.minimum(probe[:,8]+0.5,1); p1=m.predict_proba(probe)[:,1]
json.dump({"synthetic":True,"auc_synthetic_holdout":float(auc),"monotone_violations":int((p1<p0-1e-9).sum()),"n_train":n,"size_kb":round((M/"risk_lgbm.json").stat().st_size/1024)},open("reports/risk.json","w"),indent=1)
print("risk model done: synthetic AUC %.3f, monotone violations %d"%(auc,int((p1<p0-1e-9).sum())))
