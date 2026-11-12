# guard-lab data sources

Everything under `data/raw/` was copied on 9 Nov 2026 from local archives of other PayPal AI Hackathon
entries (`w/outputs/github-repository-archives/`). Each folder keeps the project's own LICENSE (all MIT).
Files ending in `.py.txt` are copied source kept **for reading only**: port the logic, don't run them.

| Folder | Project | What it is | Real or made up |
|---|---|---|---|
| `scamshield/server/eval/` | gajit9147-dev/scam-shield-paypal | 7 labelled message sets (about 2,000 rows in all): `india-heldout-split` (1,528), `random-public-sample` and `-2` (200 + more), `public-upi-dataset` (129), `heldout-set` (60), `upi-pilot-dataset` (42), `paypal-testset` (40), `paraphrase-set` (30) | Mostly real public SMS from `anmolshrivastav/scam-ham-india` and `bolewara/hinglish-scam-text-dataset` (labels by keyword, noisy); pilot, PayPal and paraphrase sets are hand-written |
| `trust-circle/src/eval/cases.ts` | prats-2311/trust-circle | 79 invented payment + message cases (43 scam, 36 genuine), incl. hard genuine ones | Made up |
| `legacy-protection/services/risk/` | Ak09patil/legacy-protection | Generator for scam payments, with every parameter sourced to FTC / FBI IC3 in `calibration.yaml` | Made up, calibrated to published statistics; "normal" spending is an assumption (the real Atlanta Fed DCPC data was never loaded) |
| `fintech-fraud-detection/ml/` | A-RYAN-1/fintech-fraud-detection | Generator + rules + logistic regression for card/UPI/wallet fraud | Made up; the generator encodes the author's own fraud logic |

Not copied:
- **Gatekeeper** (faketut/gatekeeper): no license, so its code and `model.pkl` aren't reusable. Its data is the IEEE-CIS
  fraud set on Kaggle, which needs a Kaggle account and accepting the competition rules (the owner must do that).

## Hugging Face datasets (`data/raw/hf/`, downloaded 9 Nov 2026, 129 MB)

Each folder also holds the dataset card (`README.md`). Labels are the authors' own and unverified.

| Folder | Rows | Labels | License | Kind |
|---|---|---|---|---|
| `ucirvine_sms_spam` | about 5,574 (parquet, needs pyarrow) | ham / spam | unknown | Real SMS (UK) |
| `anmolshrivastav_scam-ham-india` | 2,272 | ham 1,377 · spam 895 | Apache-2.0 | Real SMS (India); keyword labels |
| `bolewara_hinglish-scam-text-dataset` | 3,787 | 0: 3,040 · 1: 747 | CC-BY-4.0 | Hinglish messages |
| `zefang-liu_phishing-email-dataset` | 18,650 | safe 11,322 · phishing 7,328 | LGPL-3.0 | Emails |
| `BothBosu_scam-dialogue` | 1,280 train + 320 test | 50/50; 8 scam types (ssn, refund, support, reward, delivery, insurance, telemarketing, wrong number) | Apache-2.0 | AI-generated phone dialogues |
| `BothBosu_multi-agent-scam-conversation` | 1,280 train + 320 test | 50/50; 8 types incl. appointment | Apache-2.0 | AI-generated multi-agent dialogues |
| `thehamkercat_telegram-spam-ham` | 20,348 | ham 14,337 · spam 6,011 | WTFPL | Telegram messages |
| `FredZhang7_all-scam-spam` | 42,619 | 0: 25,187 · 1: 17,432 | Apache-2.0 | Mixed email + SMS spam |

Caveats before training: the sets overlap (FredZhang7 likely includes UCI and phishing emails, so dedupe
across sources before any split); "spam" is not the same as "scam" (marketing spam is mostly harmless);
the two dialogue sets are model-generated, so a model can learn their writing style instead of scam tactics.

## Added 9 Nov 2026 (second download)

| Folder | Rows | Labels | License | Kind | Notes |
|---|---|---|---|---|---|
| `sidzzz07_scamshield-dataset` | 69,286 train / 8,192 val / 8,202 test | `is_scam`; five tactic heads (urgency, fear, authority_impersonation, reward_bait, financial_pressure); intent; language (English 61k, Hindi 5.4k, Hinglish 2.8k); url/phone/otp/upi/amount flags | MIT | Real SMS, mostly the NUS Singapore corpus (Singlish genuine), plus Indian telecom, Kaggle Hindi, 3.7k synthetic tier | Best set on disk: tactic labels exist. Likely overlaps UCI and the Indian sets: dedupe. |
| `darkknight25_phishing_benign_email_dataset` | 199 | phishing/benign with intent, technique, target, spoofed_sender | MIT | Hand-written emails incl. BEC and fake invoices | Seed and frozen test for the business-scam set only. |
| `rjraj111_SMS_Spam_Multilingual_Collection_Dataset` | 5,575 | ham/spam, UCI SMS machine-translated into 21 languages | GPL | Machine translation; Chinese column is garbage, Hindi partial | Indonesian column as a robustness probe only. Never train on it. |
