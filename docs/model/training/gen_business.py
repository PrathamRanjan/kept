"""Business-targeted scam and hard-genuine messages from templates. Split BY TEMPLATE: test templates never appear
in training. Everything here is author-written and must be labelled as such in any report."""
import json, random, itertools
from pathlib import Path
random.seed(11); OUT=Path("data/processed"); OUT.mkdir(exist_ok=True)
SUP=["Northside Timber","Lee & Tan Packaging","Harbour Fresh Produce","Apex Office Supplies","BlueRiver Logistics","Mira Textiles","Kaveri Spices Pvt Ltd","Sunda Coffee Co","PT Maju Jaya","Thanawat Trading"]
PERSON=["Priya","Marcus","Lena","Tom","Dev","Noor","Sam","Aisyah","Wei Lin","Arjun"]
BANK=["DBS","OCBC","UOB","HSBC","Maybank","CIMB","BCA","Kasikorn","ICICI","Standard Chartered"]
AMT=["$1,240","$3,980","$12,500","$480","$7,300","$2,150","$15,900","$960"]
INV=["INV-2041","#8831","INV/26/0912","PO-5582","#A-1190","INV-77120"]
DAYS=["today","by 5pm","within 24 hours","before the weekend","by end of day","this afternoon"]
SCAM_T=[  # (template, tactics)
 ("Hi {p}, this is {s} accounts. Our bank has changed effective immediately. Please send {inv} ({amt}) to our new {bank} account instead. Old account is closed. Confirm once done.", ["changed_details","urgency_secrecy"]),
 ("URGENT: {s} payment details updated. Do not pay the old account. New beneficiary attached. Settle {inv} {days} to avoid a late fee.", ["changed_details","urgency_secrecy","fee_to_release"]),
 ("{p}, I'm the owner, stuck in a meeting. Change the payout account for this week's supplier run to the {bank} account I'm texting you. Keep it between us for now, I'll explain later.", ["impersonation","changed_details","urgency_secrecy"]),
 ("We accidentally overpaid {inv} by {amt}. Please refund the difference to a different account than the one we paid from, details below, {days}.", ["overpay_refund","changed_details"]),
 ("Invoice {inv} attached for {amt}. Note: we have moved to {bank}. Pay via bank transfer directly, not through PayPal, to avoid their fees.", ["off_platform","changed_details"]),
 ("Your PayPal business account will be limited in 24 hours due to a compliance review. Verify your payout details at the link to keep receiving payments.", ["impersonation","urgency_secrecy","otp_or_link"]),
 ("Hello {p}, I'm from {bank} fraud team. We flagged a payout from your account. Read me the one-time code we just sent so we can cancel it.", ["impersonation","otp_or_link","urgency_secrecy"]),
 ("Hi, I want to order {amt} of stock for a corporate gift. My company will pay by cheque for more than the total, please refund the extra to our courier via gift cards.", ["overpay_refund","gift_cards_crypto"]),
 ("This is the tax office. Your business has an outstanding penalty of {amt}. Pay {days} via the link or a warrant will be issued.", ["impersonation","urgency_secrecy","otp_or_link"]),
 ("{s} here. The refund for the returned goods ({amt}) should go to our director's personal {bank} account, not the company one. Details below. Please process {days}.", ["changed_details","urgency_secrecy"]),
 ("Final reminder: {inv} is overdue. Pay now in USDT to the wallet below to avoid collection. Discount 10% if paid in crypto {days}.", ["gift_cards_crypto","urgency_secrecy","too_good"]),
 ("Dear vendor, to release your pending payout of {amt} you must first pay a {bank} verification fee of $49. Click the link to complete.", ["fee_to_release","otp_or_link"]),
 ("Hi {p}, new customer here. I'll pay double for the booking if you can confirm {days} and send me your staff's bank login to set up a standing order.", ["too_good","otp_or_link"]),
 ("Boss asked me to tell you the supplier {s} changed their IBAN. Pay {inv} to the new one, he's on a flight and can't call. Don't mention it to accounts yet.", ["impersonation","changed_details","urgency_secrecy"]),
 ("Congratulations {p}! {s} selected your shop for a guaranteed bulk order worth {amt}. Send a {amt} deposit to secure the contract {days}.", ["too_good","fee_to_release","urgency_secrecy"]),
 ("Payment of {amt} received from your customer, but it is on hold. Pay the release charge via WhatsApp to our agent and it will be credited.", ["fee_to_release","off_platform"]),
]
GEN_T=[  # hard genuine: look risky, are not
 ("Hi {p}, {s} here. Attaching invoice {inv} for {amt}, due in 30 days as usual. Same account as always. Thanks!", []),
 ("Reminder from {s}: {inv} ({amt}) is 7 days overdue. No rush if it's already in process, just let us know.", []),
 ("Heads up: our {bank} account number is unchanged, ignore any email saying otherwise. We never ask for changes by text.", []),
 ("{p}, can you refund the duplicate payment on {inv}? Please send it back to the same account we paid from. Cheers.", []),
 ("Hi, this is {s}. Our PayPal invoice {inv} for {amt} is ready, pay whenever convenient this month.", []),
 ("Team, {bank} has scheduled maintenance tonight; transfers may be delayed until tomorrow morning. Nothing to do.", []),
 ("Hello {p}, we'd like to place a repeat order of {amt}. Please send the PayPal invoice and we'll pay within terms.", []),
 ("Note from accounts: {inv} was paid on Monday to {s}, reference attached. Closing the item.", []),
 ("Your payout of {amt} has completed to the account ending 4471. View details in your PayPal dashboard.", []),
 ("Hi {p}, I'm {s}'s new bookkeeper. No changes to payment details; just confirming you received {inv}. Thanks.", []),
 ("Supplier meeting moved to {days}. Bring the open invoices list, {inv} and {inv} need approval.", []),
 ("Security notice: we will never ask for your one-time code. If anyone does, hang up and call the number on your card.", []),
 ("Customer wants to pay the {amt} deposit by PayPal now and the balance on collection. Fine by me, go ahead.", []),
 ("{s}: our bank details change only through a signed letter and a verification call back to a known number. This message is informational only.", []),
 ("Order {inv} shipped. Tracking in the PayPal order. Payment captured earlier, nothing further due.", []),
 ("Hi {p}, could you resend invoice {inv}? The PDF didn't attach. Same amount {amt}.", []),
]
def fill(t):
    return t.format(p=random.choice(PERSON), s=random.choice(SUP), bank=random.choice(BANK), amt=random.choice(AMT), inv=random.choice(INV), days=random.choice(DAYS))
TACTICS=["impersonation","urgency_secrecy","changed_details","off_platform","gift_cards_crypto","fee_to_release","otp_or_link","overpay_refund","too_good"]
def rows(templates, label, n_per, split):
    out=[]
    for i,(t,tac) in enumerate(templates):
        for _ in range(n_per):
            out.append({"text":fill(t),"source":f"business_synth_{split}","lang":"English","label":label,"tactics":{k:int(k in tac) for k in TACTICS},"tactic_provenance":"labelled" if label=="scam" else "none","template":i})
    return out
# template split: last 4 scam templates and last 4 genuine templates are test-only
tr=rows(SCAM_T[:-4],"scam",25,"train")+rows(GEN_T[:-4],"genuine",25,"train")
te=rows(SCAM_T[-4:],"scam",25,"test")+rows(GEN_T[-4:],"genuine",25,"test")
random.shuffle(tr); random.shuffle(te)
for name,data in (("train_business",tr),("test_business",te)):
    with open(OUT/f"{name}.jsonl","w") as f:
        for r in data: f.write(json.dumps(r,ensure_ascii=False)+"\n")
    print(name,len(data),"scam",sum(r["label"]=="scam" for r in data))
