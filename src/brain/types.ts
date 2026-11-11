import type { Rules } from "../policy/rules.js";
import type { EligibleOffer } from "../policy/eligibility.js";
import type { IntervalUnit } from "../paypal/types.js";

export interface DraftPlan {
  name: string;
  description: string;
  price: number;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  kind: "regular" | "lite";
}

export interface Draft<T> {
  value: T;
  /** What the brain understood, in plain words, for the owner to check. */
  understood: string[];
  /** What it could not use or will not do. */
  warnings: string[];
}

export type ReasonCategory = "price" | "too_much" | "away" | "quality" | "competitor" | "no_need" | "payment" | "other";

export interface OfferChoice {
  key: string | null;
  rationale: string;
}

export interface ShopStats {
  merchantName: string;
  currency: string;
  active: number;
  suspended: number;
  cancelled: number;
  mrr: number;
  revenueKept3: number;
  offersMade: number;
  offersAccepted: number;
  cancelsHonoured: number;
  agentShare: number;
  reasons: { category: ReasonCategory; count: number; examples: string[] }[];
  failing: { name: string; outstanding: number }[];
  upcomingRenewals7d: number;
}

/**
 * Everything Kept treats as "AI". The local implementation is deterministic so the product runs
 * with no model API; an LLM-backed implementation can replace it behind the same interface.
 * Whatever the implementation, it only proposes: code validates, the owner approves, the executor acts.
 */
export interface Brain {
  readonly name: string;
  draftPlans(text: string, currency: string): Promise<Draft<DraftPlan[]>>;
  draftRules(text: string): Promise<Draft<Rules>>;
  classifyReason(text: string): Promise<ReasonCategory>;
  /** Deterministic in every implementation: a model never chooses among offers (eligibility and money are code). */
  pickOffer(eligible: EligibleOffer[], category: ReasonCategory): OfferChoice;
  wordOffer(offer: EligibleOffer, ctx: { merchantName: string; currency: string; category: ReasonCategory; subscriberName?: string | null }): Promise<string>;
  explainPaymentFailure(ctx: { merchantName: string; amount: number; currency: string; attempts: number; manageUrl: string }): Promise<string>;
  /** `facts` (spec K3) are plain-word lines computed by code; when given, the model sees them instead of `stats`. */
  answer(question: string, stats: ShopStats, facts?: string[]): Promise<string>;
  /** Who produced the last output: "model" (primary), "backup" (second model), "code" (code's own template for a decision code made), "failed", or "rules" (the offline test brain). */
  lastVia(): string;
  lastModel?(): string | null;
}
