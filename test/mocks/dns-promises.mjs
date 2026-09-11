import { state } from "./state.mjs";

export function lookup(hostname, options) {
  state.dnsCalls.push({ hostname, options });
  const plan = state.dnsPlans.shift() ?? { addresses: [] };
  if (plan.kind === "pending") return new Promise(() => {});
  if (plan.kind === "error") return Promise.reject(plan.error ?? new Error("mock lookup failure"));
  return Promise.resolve(plan.addresses ?? []);
}
