export type StampKind = "paid" | "discount" | "skipped" | "paused" | "failed" | "upcoming";
export interface Stamp { kind: StampKind; date: string; amount: string | null; next?: boolean; scheduled?: boolean }
export interface CycleCardData { stamps: Stamp[]; end: { kind: "cancelled" | "cancel_pending"; date: string | null } | null; every: string }
export interface PlanJson { id: string; name: string; description: string | null; price: string; currency: string; billing: string; kind: string; paypal_plan_id?: string }
export interface TimelineStep { n: number; who: "AI" | "Rule" | "PayPal" | "Person" | "Agent"; tool: string; gate: string | null; text: string; policy: string | null; ms: number | null; pp_request_id: string | null; pp_debug_id: string | null; at: string }
export interface TimelineRun { id: string; subject: string; actor: string; agent_id: string | null; status: string; at: string; steps: TimelineStep[] }
export interface Session { owner: { name: string; slug: string } | null; demoMode: boolean; demoShop: string; demoMemberRef: string | null; ai: "model" | "rules"; paypalEnv: string }
