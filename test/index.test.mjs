import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { state, resetState } from "./mocks/state.mjs";

const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  state.fetchCalls.push({
    url: String(url),
    method: init.method,
    headers: Object.fromEntries(new Headers(init.headers)),
    body: init.body,
    redirect: init.redirect,
  });
  const plan = state.fetchPlans.shift() ?? { body: JSON.stringify({ success: true, data: {} }) };
  if (plan.kind === "throw") throw plan.error ?? new Error("mock fetch failure");
  if (plan.kind === "pending") {
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }
  return new Response(plan.body ?? "", { status: plan.status ?? 200, headers: plan.headers });
};

after(() => {
  globalThis.fetch = originalFetch;
});

const piApiModule = await import("@earendil-works/pi-coding-agent");
const extensionModule = await import("../index.ts");
const tools = new Map();
extensionModule.default({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
});

beforeEach(() => {
  resetState();
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_URL;
});

function credentials(value = { apiKey: "stored-test-key", apiUrl: "https://api.firecrawl.dev" }) {
  state.credentialsText = JSON.stringify(value);
}

function jsonResponse(value, status = 200, headers) {
  state.fetchPlans.push({ body: JSON.stringify(value), status, headers });
}

function publicDns(...addresses) {
  state.dnsPlans.push({ addresses: addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) });
}

async function invoke(name, params, signal) {
  const tool = tools.get(name);
  assert.ok(tool, `registered ${name}`);
  const result = await tool.execute("test-call", params, signal);
  return JSON.parse(result.content[0].text);
}

async function withFastTimers(run) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, Math.min(Number(delay) || 0, 5), ...args);
  try {
    return await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("loads installed Pi APIs and registers exactly the three supported tools", () => {
  assert.ok(piApiModule);
  assert.deepEqual([...tools.keys()].sort(), [
    "firecrawl_developer",
    "firecrawl_question",
    "firecrawl_search",
  ]);
  assert.deepEqual(Object.keys(extensionModule.QuestionParameters.properties).sort(), ["question", "url"]);
});

test("focused question sends only QuestionFormat and returns qualified formatted output", async () => {
  credentials();
  publicDns("8.8.8.8");
  jsonResponse({
    success: true,
    data: { answer: "Summary:\n  ```ts\n  answer()\n  ```" },
  });

  const result = await invoke("firecrawl_question", {
    url: "https://public.example/page",
    question: "What does this do?",
  });

  assert.equal(state.readFileCalls.length, 1);
  assert.equal(state.fetchCalls.length, 1);
  assert.equal(state.fetchCalls[0].url, "https://api.firecrawl.dev/v2/scrape");
  assert.equal(state.fetchCalls[0].headers.authorization, "Bearer stored-test-key");
  const request = JSON.parse(state.fetchCalls[0].body);
  assert.deepEqual(Object.keys(request).sort(), ["formats", "onlyMainContent", "url"]);
  assert.deepEqual(request.formats, [{ type: "question", question: "What does this do?" }]);
  assert.equal(JSON.stringify(request).includes("markdown"), false);
  assert.equal(JSON.stringify(request).includes('"json"'), false);
  assert.equal(result.answer, "Summary:\n  ```ts\n  answer()\n  ```");
  assert.equal(result.source, "https://public.example/page");
  assert.equal(result.answer_type, "generated_summary");
  assert.equal(result.evidence, "not independently verified");
  assert.equal(result.truncated, undefined);
});

test("focused question rejects non-answer and malformed response shapes", async () => {
  const cases = [
    ["HTTP failure", { status: 500, body: JSON.stringify({ error: "failed" }) }, /HTTP 500/],
    ["API failure", { body: JSON.stringify({ success: false, error: "failed" }) }, /no structured focused answer/],
    ["invalid JSON", { body: "not-json" }, /invalid JSON/],
    ["missing data", { body: JSON.stringify({ success: true }) }, /no structured focused answer/],
    ["null answer", { body: JSON.stringify({ success: true, data: { answer: null } }) }, /no structured focused answer/],
    ["wrong-type answer", { body: JSON.stringify({ success: true, data: { answer: 7 } }) }, /no structured focused answer/],
    ["whitespace answer", { body: JSON.stringify({ success: true, data: { answer: " \n\t " } }) }, /no focused answer/],
    ["Markdown only", { body: JSON.stringify({ success: true, data: { markdown: "# page" } }) }, /no structured focused answer/],
  ];

  for (const [label, plan, expected] of cases) {
    resetState();
    credentials();
    publicDns("8.8.8.8");
    state.fetchPlans.push(plan);
    await assert.rejects(
      invoke("firecrawl_question", { url: "https://public.example/page", question: "Question" }),
      expected,
      label,
    );
  }
});

test("focused-question answer bounds are explicit at 4,000 characters", async () => {
  for (const [answer, truncated] of [["a".repeat(4_000), false], ["b".repeat(4_001), true]]) {
    resetState();
    credentials();
    publicDns("8.8.8.8");
    jsonResponse({ success: true, data: { answer } });
    const result = await invoke("firecrawl_question", { url: "https://public.example/page", question: "Question" });
    assert.equal(result.answer.length, 4_000);
    assert.equal(result.truncated === true, truncated);
    if (truncated) assert.equal(result.answer.endsWith("…"), true);
  }
});

test("developer uses CLI only when unscoped and preserves shell metacharacters as one argument", async () => {
  const query = "find $(not-run); `also-not-run`";
  state.cliPlans.push({
    stdout: JSON.stringify({
      success: true,
      results: [{
        id: "readme:owner/repo",
        url: "https://github.com/owner/repo",
        title: "Repo",
        passages: [{ text: "line one\n  ```ts\n  code()\n  ```" }],
      }],
    }),
  });

  const result = await invoke("firecrawl_developer", { query });

  assert.equal(state.fetchCalls.length, 0);
  assert.equal(state.cliCalls.length, 1);
  assert.deepEqual(state.cliCalls[0].args, ["developer", query, "--limit", "3", "--json"]);
  assert.equal(state.cliCalls[0].shell, undefined);
  assert.deepEqual(state.cliCalls[0].stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(result.results[0].passage, "line one\n  ```ts\n  code()\n  ```");
});

test("developer scopes use structured filters before limits", async () => {
  credentials();
  jsonResponse({
    success: true,
    results: [{
      id: "issue:owner/repo#1",
      url: "https://github.com/owner/repo/issues/1",
      title: "Issue",
      passages: [{ text: "matched" }],
    }],
    repos: [{ repo: "owner/repo", indexed: true, types: { issue: true } }],
  });

  const result = await invoke("firecrawl_developer", {
    query: "failure",
    repo: "owner/repo",
    type: "issue",
    limit: 2,
  });
  const requestUrl = new URL(state.fetchCalls[0].url);
  assert.equal(requestUrl.pathname, "/v2/search/developer");
  assert.equal(requestUrl.searchParams.get("query"), "failure");
  assert.equal(requestUrl.searchParams.get("k"), "2");
  assert.equal(requestUrl.searchParams.get("passages"), "1");
  assert.deepEqual(requestUrl.searchParams.getAll("repos"), ["owner/repo"]);
  assert.deepEqual(requestUrl.searchParams.getAll("types"), ["issue"]);
  assert.equal(state.cliCalls.length, 0);
  assert.deepEqual(result.scope, { repo: "owner/repo", indexed: true });

  resetState();
  credentials();
  jsonResponse({ success: true, results: [], repos: [{ repo: "owner/repo", indexed: false, types: {} }] });
  const empty = await invoke("firecrawl_developer", { query: "none", repo: "owner/repo" });
  const repoOnly = new URL(state.fetchCalls[0].url);
  assert.deepEqual(repoOnly.searchParams.getAll("types").sort(), ["issue", "pull_request", "readme"]);
  assert.deepEqual(empty.results, []);
  assert.deepEqual(empty.scope, { repo: "owner/repo", indexed: false });
});

test("developer rejects unsupported and malformed scope responses", async () => {
  await assert.rejects(
    invoke("firecrawl_developer", { query: "docs", repo: "owner/repo", type: "doc" }),
    /Documentation sources cannot be scoped by repository/,
  );
  await assert.rejects(
    invoke("firecrawl_developer", { query: "bad", repo: "not a repo" }),
    /GitHub owner\/name/,
  );
  assert.equal(state.fetchCalls.length, 0);
  assert.equal(state.cliCalls.length, 0);

  resetState();
  credentials();
  jsonResponse({
    success: true,
    results: [{ id: "doc:https://docs.example/", url: "https://docs.example/", passages: [{ text: "wrong" }] }],
    repos: [{ repo: "owner/repo", indexed: true, types: {} }],
  });
  await assert.rejects(
    invoke("firecrawl_developer", { query: "wrong", repo: "owner/repo", type: "issue" }),
    /outside the requested scope/,
  );

  resetState();
  credentials();
  jsonResponse({ success: true, results: [] });
  await assert.rejects(
    invoke("firecrawl_developer", { query: "missing", repo: "owner/repo" }),
    /did not confirm the repository scope/,
  );
});

test("advanced search forwards explicit CLI controls and bounds multiline snippets", async () => {
  state.cliPlans.push({
    stdout: JSON.stringify({
      success: true,
      data: {
        web: [
          { title: "One", url: "https://one.example/", description: `head\n  \`\`\`js\n${"x".repeat(640)}\n  \`\`\`` },
          { title: "Two", url: "https://two.example/", description: "two" },
          { title: "Three", url: "https://three.example/", description: "three" },
        ],
      },
    }),
  });

  const result = await invoke("firecrawl_search", {
    query: "alpha; $(not-run)",
    source: "news",
    category: "github",
    recency: "week",
    limit: 2,
  });

  assert.deepEqual(state.cliCalls[0].args, [
    "search", "alpha; $(not-run)", "--limit", "2", "--highlights", "--json",
    "--sources", "news", "--categories", "github", "--tbs", "qdr:w",
  ]);
  assert.equal(state.cliCalls[0].shell, undefined);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].snippet.includes("\n  ```js\n"), true);
  assert.equal(result.results[0].snippet.length, 650);
  assert.equal(result.results[0].truncated, true);
});

test("operational errors, cancellation, timeout, and response limits stay bounded and sanitized", async () => {
  state.cliPlans.push({ code: 1, stderr: "https://public.example/?token=cli-secret\nBearer fc-not-a-real-key" });
  await assert.rejects(
    invoke("firecrawl_search", { query: "query" }),
    (error) => !/cli-secret|fc-not-a-real-key|public\.example/.test(error.message),
  );

  resetState();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    invoke("firecrawl_search", { query: "query" }, cancelled.signal),
    /cancelled/,
  );
  assert.equal(state.cliCalls.length, 0);

  resetState();
  state.cliPlans.push({ kind: "stall" });
  await withFastTimers(() => assert.rejects(invoke("firecrawl_search", { query: "query" }), /timed out/));
  assert.equal(state.cliKills.length, 1);

  resetState();
  state.cliPlans.push({ stdout: "x".repeat(2_000_001) });
  await assert.rejects(invoke("firecrawl_search", { query: "query" }), /exceeded the safety limit/);

  resetState();
  credentials();
  state.fetchPlans.push({ body: "x".repeat(2_000_001) });
  await assert.rejects(
    invoke("firecrawl_developer", { query: "query", type: "issue" }),
    /exceeded the safety limit/,
  );

  resetState();
  credentials();
  state.fetchPlans.push({ kind: "pending" });
  await withFastTimers(() => assert.rejects(
    invoke("firecrawl_developer", { query: "query", type: "issue" }),
    /timed out/,
  ));

  resetState();
  credentials();
  state.fetchPlans.push({ kind: "pending" });
  const controller = new AbortController();
  const pending = invoke("firecrawl_developer", { query: "query", type: "issue" }, controller.signal);
  for (let turn = 0; state.fetchCalls.length === 0 && turn < 4; turn += 1) await Promise.resolve();
  assert.equal(state.fetchCalls.length, 1);
  controller.abort();
  await assert.rejects(pending, /cancelled/);

  resetState();
  credentials();
  state.fetchPlans.push({ kind: "throw", error: new Error("https://api.example/?token=transport-secret") });
  await assert.rejects(
    invoke("firecrawl_developer", { query: "query", type: "issue" }),
    (error) => !/transport-secret|api\.example/.test(error.message),
  );

  resetState();
  credentials({ apiKey: "stored-key", apiUrl: "https://stored.example" });
  process.env.FIRECRAWL_API_KEY = "environment-key";
  process.env.FIRECRAWL_API_URL = "https://environment.example";
  jsonResponse({ success: true, results: [] });
  await invoke("firecrawl_developer", { query: "query", type: "issue" });
  assert.equal(state.fetchCalls[0].url, "https://environment.example/v2/search/developer?query=query&k=3&passages=1&types=issue");
  assert.equal(state.fetchCalls[0].headers.authorization, "Bearer environment-key");
});

test("public URL boundary blocks unsafe literals and names before Firecrawl submission", async () => {
  const unsafeUrls = [
    "not a url",
    "file:///etc/passwd",
    "https://user:password@public.example/",
    "https://localhost/",
    "https://internal.local/",
    "https://127.0.0.1/",
    "https://10.0.0.1/",
    "https://169.254.1.1/",
    "https://192.0.2.1/",
    "https://198.18.0.1/",
    "https://[::1]/",
    "https://[fc00::1]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://2130706433/",
    "https://0x7f000001/",
  ];
  for (const url of unsafeUrls) {
    resetState();
    await assert.rejects(
      invoke("firecrawl_question", { url, question: "Question" }),
      /url must|url host/,
      url,
    );
    assert.equal(state.fetchCalls.length, 0, url);
  }
});

test("public URL boundary allows public addresses and rejects unsafe DNS outcomes", async () => {
  for (const url of ["https://8.8.8.8/", "https://[2001:4860:4860::8888]/"]) {
    resetState();
    credentials();
    jsonResponse({ success: true, data: { answer: "ok" } });
    const result = await invoke("firecrawl_question", { url, question: "Question" });
    assert.equal(result.answer, "ok");
    assert.equal(state.dnsCalls.length, 0);
  }

  resetState();
  credentials();
  publicDns("8.8.8.8", "2001:4860:4860::8888");
  jsonResponse({ success: true, data: { answer: "ok" } });
  await invoke("firecrawl_question", { url: "https://public.example/", question: "Question" });
  assert.equal(state.fetchCalls.length, 1);

  for (const plan of [
    { addresses: [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] },
    { addresses: [] },
    { kind: "error" },
  ]) {
    resetState();
    state.dnsPlans.push(plan);
    await assert.rejects(
      invoke("firecrawl_question", { url: "https://public.example/", question: "Question" }),
      /resolve only|could not be resolved/,
    );
    assert.equal(state.fetchCalls.length, 0);
  }

  resetState();
  state.dnsPlans.push({ kind: "pending" });
  await withFastTimers(() => assert.rejects(
    invoke("firecrawl_question", { url: "https://public.example/", question: "Question" }),
    /host validation timed out/,
  ));
  assert.equal(state.fetchCalls.length, 0);

  resetState();
  state.dnsPlans.push({ kind: "pending" });
  const controller = new AbortController();
  const pending = invoke("firecrawl_question", { url: "https://public.example/", question: "Question" }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(state.fetchCalls.length, 0);
});

test("sensitive URL values are redacted from output and errors", async () => {
  credentials();
  publicDns("8.8.8.8");
  jsonResponse({ success: true, data: { answer: "ok" } });
  const result = await invoke("firecrawl_question", {
    url: "https://public.example/path?token=source-secret&safe=value",
    question: "Question",
  });
  assert.equal(result.source.includes("source-secret"), false);
  assert.equal(result.source.includes("token=redacted"), true);

  resetState();
  credentials();
  publicDns("8.8.8.8");
  state.fetchPlans.push({ status: 500, body: JSON.stringify({ error: "https://public.example/?token=error-secret" }) });
  const logged = [];
  const originalError = console.error;
  console.error = (...values) => logged.push(values.join(" "));
  try {
    await assert.rejects(
      invoke("firecrawl_question", { url: "https://public.example/?token=error-secret", question: "Question" }),
      (error) => !/error-secret|public\.example/.test(error.message),
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logged, []);
});

test("direct HTTP disables automatic API redirects", async () => {
  credentials();
  jsonResponse({ success: true, results: [] });
  await invoke("firecrawl_developer", { query: "query", type: "issue" });
  assert.equal(
    state.fetchCalls[0].redirect,
    "error",
    "credentialed structured HTTP must reject redirects instead of following them by default",
  );
});
