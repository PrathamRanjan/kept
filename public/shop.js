// PayPal JS SDK subscription buttons. The subscription is created on Kept's server (so Kept records it first),
// then PayPal's popup collects the subscriber's approval.
(function () {
  if (!window.paypal) return;
  document.querySelectorAll(".subscribe-form").forEach(function (form) {
    var planId = form.getAttribute("data-plan");
    var slug = form.getAttribute("data-slug");
    var target = form.querySelector(".pp-button");
    if (!target) return;
    var ref = null;
    window.paypal
      .Buttons({
        style: { shape: "rect", layout: "vertical", label: "subscribe", height: 40 },
        createSubscription: function () {
          var body = new URLSearchParams({ plan_id: planId, name: form.name.value || "", email: form.email.value || "" });
          return fetch("/s/" + slug + "/subscribe", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: body })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (!j.paypal_subscription_id) throw new Error(j.error || "Could not start the subscription");
              ref = j.ref;
              return j.paypal_subscription_id;
            });
        },
        onApprove: function () { window.location.href = "/r/" + ref; },
        onCancel: function () { if (ref) window.location.href = "/r/" + ref + "?cancelled=1"; },
        onError: function (err) { alert("PayPal couldn't complete that: " + (err && err.message ? err.message : err)); },
      })
      .render(target)
      .catch(function () { target.style.display = "none"; });
  });
})();
