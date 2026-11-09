import { PayPalError, type PayPalApi } from "./types.js";

/**
 * Demo failure lab: the owner can make the next call to one PayPal method fail once with a 503, to show
 * that Kept never reports a cancellation PayPal hasn't confirmed and keeps retrying it. Demo mode only.
 * Faults live in memory: the web server and the inline worker share them.
 */
export const FAULTABLE = ["cancelSubscription", "reviseSubscription", "suspendSubscription", "activateSubscription"] as const;
const armed = new Set<string>();

export function armFault(method: (typeof FAULTABLE)[number]) {
  armed.add(method);
}
export function armedFaults() {
  return [...armed];
}

export function withFaults(api: PayPalApi): PayPalApi {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && armed.delete(prop)) {
          return Promise.reject(new PayPalError(`Service unavailable (demo fault on ${prop})`, 503, "SERVICE_UNAVAILABLE", "demo-fault", null));
        }
        return v.apply(target, args);
      };
    },
  });
}
