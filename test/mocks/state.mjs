export const state = {};

export function resetState() {
  state.cliCalls = [];
  state.cliPlans = [];
  state.cliKills = [];
  state.dnsCalls = [];
  state.dnsPlans = [];
  state.fetchCalls = [];
  state.fetchPlans = [];
  state.readFileCalls = [];
  state.credentialsText = undefined;
  state.credentialsError = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

resetState();
