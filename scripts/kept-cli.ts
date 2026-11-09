/**
 * kept: a small CLI over the running server's HTTP API, for owners and for agents that prefer a shell.
 *   KEPT_URL (default http://localhost:3000) and KEPT_OWNER_KEY (own_...) for owner commands.
 *
 *   kept shops                         list shops and plans
 *   kept sub <ref>                     a subscription
 *   kept cancel <ref> [--hear] [reason] cancel (one optional offer)
 *   kept skip|resume <ref>
 *   kept runs [limit]                  owner: recent agent runs
 *   kept trace <run_id>                owner: one run's steps
 *   kept approvals                     owner: pending approvals
 *   kept stats | compliance | audit | kills | transactions
 */
const url = (process.env.KEPT_URL ?? "http://localhost:3000").replace(/\/$/, "");
const key = process.env.KEPT_OWNER_KEY ?? "";
const [cmd, ...rest] = process.argv.slice(2);
const owner = () => {
  if (!key) throw new Error("Set KEPT_OWNER_KEY=own_... for owner commands.");
  return { authorization: `Bearer ${key}` };
};
async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(url + path, { ...init, headers: { "content-type": "application/json", accept: "application/json", "x-agent-id": "kept-cli", ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  if (!res.ok) throw new Error(`${res.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const flag = (f: string) => rest.includes(f);
const args = rest.filter((a) => !a.startsWith("--"));
try {
  switch (cmd) {
    case "shops": show(await call("/api/v1/shops")); break;
    case "sub": show(await call(`/api/v1/subscriptions/${args[0]}`)); break;
    case "cancel": show(await call(`/api/v1/subscriptions/${args[0]}/cancel`, { method: "POST", body: JSON.stringify({ hear_offer: flag("--hear"), reason: args.slice(1).join(" ") || undefined }) })); break;
    case "skip": show(await call(`/api/v1/subscriptions/${args[0]}/skip`, { method: "POST", body: "{}" })); break;
    case "resume": show(await call(`/api/v1/subscriptions/${args[0]}/resume`, { method: "POST", body: "{}" })); break;
    case "runs": show(await call(`/api/v1/runs?limit=${args[0] ?? 20}`, { headers: owner() })); break;
    case "trace": show(await call(`/api/v1/runs/${args[0]}`, { headers: owner() })); break;
    case "stats": show(await call("/api/v1/owner/stats", { headers: owner() })); break;
    case "compliance": show(await call("/dashboard/compliance.json", { headers: owner() })); break;
    case "audit": show(await call("/dashboard/guard/audit.json", { headers: owner() })); break;
    case "kills": show(await call("/dashboard/guard/kills.json", { headers: owner() })); break;
    case "transactions": show(await call("/dashboard/money/transactions.json", { headers: owner() })); break;
    case "approvals": {
      const r = (await call("/dashboard/guard/audit.json", { headers: owner() })) as any;
      show((r.recent ?? []).filter((a: any) => /approval/.test(a.event)));
      break;
    }
    default:
      console.log("kept shops | sub <ref> | cancel <ref> [--hear] [reason] | skip <ref> | resume <ref> | runs | trace <id> | approvals | stats | compliance | audit | kills | transactions");
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
