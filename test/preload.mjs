import { registerHooks } from "node:module";

const extensionUrl = new URL("../index.ts", import.meta.url).href;
const extensionMocks = new Map([
  ["node:child_process", new URL("./mocks/child-process.mjs", import.meta.url).href],
  ["node:dns/promises", new URL("./mocks/dns-promises.mjs", import.meta.url).href],
  ["node:fs/promises", new URL("./mocks/fs-promises.mjs", import.meta.url).href],
  ["@earendil-works/pi-ai", "file:///home/brian/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js"],
  ["typebox", "file:///home/brian/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = context.parentURL === extensionUrl ? extensionMocks.get(specifier) : undefined;
    if (mock) return { url: mock, shortCircuit: true };
    if (specifier === "@earendil-works/pi-coding-agent") {
      return {
        url: "file:///home/brian/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
