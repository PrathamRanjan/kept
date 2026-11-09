import { config } from "../config.js";
import { hasOpenAI } from "../ai/provider.js";
import { LocalBrain } from "./local.js";
import { OpenAIBrain } from "./openai.js";
import type { Brain } from "./types.js";

let brain: Brain | null = null;

/**
 * Returns the configured brain. With KEPT_BRAIN=openai (the default when OPENAI_API_KEY is set) the model brain
 * drafts, labels and words; it falls back to the deterministic local brain per call and says which answered.
 * Whatever the brain, eligibility, offer choice, prices and every PayPal call are code.
 */
export function getBrain(): Brain {
  if (brain) return brain;
  brain = config.brain === "openai" && hasOpenAI() ? new OpenAIBrain() : new LocalBrain();
  if (config.brain === "openai" && !hasOpenAI()) console.warn("[kept] KEPT_BRAIN=openai but AI_PROVIDER/OPENAI_API_KEY are not set; using the local brain.");
  return brain;
}

/** Tests swap brains. */
export function setBrain(b: Brain | null) {
  brain = b;
}

export type { Brain } from "./types.js";
