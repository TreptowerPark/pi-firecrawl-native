import { EventEmitter } from "node:events";
import { state } from "./state.mjs";

export function spawn(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    state.cliKills.push({ command, args: [...args], signal });
    return true;
  };

  state.cliCalls.push({
    command,
    args: [...args],
    shell: options.shell,
    stdio: options.stdio,
  });
  const plan = state.cliPlans.shift() ?? { stdout: JSON.stringify({ success: true, results: [] }) };
  queueMicrotask(() => {
    if (plan.kind === "stall") return;
    if (plan.kind === "error") {
      child.emit("error", plan.error ?? new Error("mock spawn error"));
      return;
    }
    if (plan.stdout) child.stdout.emit("data", Buffer.from(plan.stdout));
    if (plan.stderr) child.stderr.emit("data", Buffer.from(plan.stderr));
    child.emit("close", plan.code ?? 0);
  });
  return child;
}
