/*
 * Kept's cancel widget (spec B5 differentiator 5). One script tag on any shop's own site:
 *   <script src="https://pph-kept.onrender.com/widget.js" data-shop="your-shop" async></script>
 * Optional: data-ref="ref_..." when the page already knows the member (a signed-in account page), and
 * data-label to change the button text. It adds one button where the tag sits. The button opens the member's Kept
 * page, where skip, pause, switch and a one-step cancel live. It reads nothing from the page it is on, sets no
 * cookies and loads nothing else.
 */
(function () {
  var me = document.currentScript;
  if (!me) return;
  var origin = new URL(me.src).origin;
  var shop = me.getAttribute("data-shop") || "";
  var ref = me.getAttribute("data-ref") || "";
  var label = me.getAttribute("data-label") || "Manage or cancel my subscription";
  var wrap = document.createElement("div");
  wrap.className = "kept-widget";
  wrap.style.cssText = "font:16px/1.4 system-ui,sans-serif;margin:8px 0";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.style.cssText = "min-height:44px;padding:10px 16px;border-radius:10px;border:1px solid #1f2a24;background:#fff;color:#1f2a24;cursor:pointer;font:inherit";
  var form = document.createElement("form");
  form.hidden = true;
  form.style.cssText = "margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:end";
  var id = "kept-ref-" + Math.random().toString(36).slice(2, 8);
  form.innerHTML = '<label for="' + id + '" style="display:block;width:100%">Your subscription reference (in every message from the shop, starts with ref_)</label>' +
    '<input id="' + id + '" required pattern="ref_[A-Za-z0-9]+" autocomplete="off" style="min-height:44px;padding:8px;border:1px solid #888;border-radius:8px;font:inherit">' +
    '<button type="submit" style="min-height:44px;padding:8px 14px;border-radius:8px;border:1px solid #1f2a24;background:#1f2a24;color:#fff;font:inherit">Open</button>';
  var open = function (r) { window.open(origin + "/manage/" + encodeURIComponent(r) + "?from=widget" + (shop ? "&shop=" + encodeURIComponent(shop) : ""), "_blank", "noopener"); };
  btn.addEventListener("click", function () {
    if (ref) return open(ref);
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector("input").focus();
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); open(form.querySelector("input").value.trim()); });
  wrap.appendChild(btn);
  wrap.appendChild(form);
  me.parentNode.insertBefore(wrap, me.nextSibling);
})();
