import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const FIRECRAWL_COMMAND = process.env.PI_FIRECRAWL_COMMAND || "firecrawl";
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const MAX_CLI_OUTPUT_BYTES = 2_000_000;
const MAX_PASSAGE_CHARS = 650;
const MAX_QUESTION_CHARS = 4_000;
const MAX_ERROR_CHARS = 240;
const REQUEST_TIMEOUT_MS = 120_000;
const FOCUSED_FALLBACK_SCHEMA = JSON.stringify({
  type: "object",
  properties: { answer: { type: "string" } },
});

const DEVELOPER_TYPES = ["doc", "readme", "issue", "pull_request"] as const;
const SEARCH_SOURCES = ["web", "news"] as const;
const SEARCH_CATEGORIES = ["github", "developer", "research", "pdf"] as const;
const RECENCY_VALUES = ["day", "week", "month", "year"] as const;

export const DeveloperParameters = Type.Object({
  query: Type.String({ description: "Developer query" }),
  repo: Type.Optional(Type.String({ description: "GitHub owner/name" })),
  type: Type.Optional(StringEnum(DEVELOPER_TYPES, { description: "Artifact type" })),
  limit: Type.Optional(Type.Integer({ description: "Max results", minimum: 1, maximum: MAX_LIMIT })),
});

export const QuestionParameters = Type.Object({
  url: Type.String({ description: "Known HTTP(S) URL" }),
  question: Type.String({ description: "Concrete page question" }),
});

export const SearchParameters = Type.Object({
  query: Type.String({ description: "Search query" }),
  source: Type.Optional(StringEnum(SEARCH_SOURCES, { description: "web or news" })),
  category: Type.Optional(StringEnum(SEARCH_CATEGORIES, { description: "Firecrawl category" })),
  recency: Type.Optional(StringEnum(RECENCY_VALUES, { description: "Time window" })),
  limit: Type.Optional(Type.Integer({ description: "Max results", minimum: 1, maximum: MAX_LIMIT })),
});

type DeveloperInput = {
  query: string;
  repo?: string;
  type?: (typeof DEVELOPER_TYPES)[number];
  limit?: number;
};

type QuestionInput = {
  url: string;
  question: string;
};

type SearchInput = {
  query: string;
  source?: (typeof SEARCH_SOURCES)[number];
  category?: (typeof SEARCH_CATEGORIES)[number];
  recency?: (typeof RECENCY_VALUES)[number];
  limit?: number;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: unknown, maxChars: number): string {
  const text = cleanText(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function requiredText(value: unknown, label: string, maxChars = 8_000): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxChars) throw new Error(`${label} is too long`);
  return text;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

function safeDiagnostic(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter((line) => line.length > 0)
    .filter((line) => !/(scrape id|session|credential|authorization|bearer|api.?key|token)/i.test(line));
  const diagnostic = lines[0] || `Firecrawl request failed (exit ${code ?? "unknown"})`;
  return diagnostic
    .replace(/fc-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https?:\/\/[^\s]*[?&](?:api[_-]?key|token)=[^\s]*/gi, "[redacted-url]")
    .slice(0, MAX_ERROR_CHARS);
}

function runFirecrawl(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Firecrawl request cancelled"));
      return;
    }

    const child = spawn(FIRECRAWL_COMMAND, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    };

    const abort = (): void => {
      child.kill("SIGTERM");
      finish(new Error("Firecrawl request cancelled"));
    };

    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Firecrawl request timed out"));
    }, REQUEST_TIMEOUT_MS);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Firecrawl response exceeded the safety limit"));
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (error) => finish(new Error(`Unable to run Firecrawl: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) finish(new Error(safeDiagnostic(stderr, code)));
      else finish();
    });
  });
}

function parseJson(text: string, label: string): JsonObject {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new Error("response is not an object");
    return value;
  } catch {
    throw new Error(`Firecrawl ${label} returned invalid JSON`);
  }
}

function textResult(value: unknown): { content: [{ type: "text"; text: string }]; details: {} } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
}

function developerType(id: unknown, fallback: unknown): string {
  const prefix = typeof id === "string" ? id.split(":", 1)[0] : "";
  if ((DEVELOPER_TYPES as readonly string[]).includes(prefix)) return prefix;
  return typeof fallback === "string" ? fallback : "unknown";
}

function developerQuery(input: DeveloperInput): string {
  const query = requiredText(input.query, "query");
  const scope: string[] = [];
  if (input.repo) scope.push(`repository ${requiredText(input.repo, "repo", 300)}`);
  if (input.type) scope.push(`${input.type.replace("_", " ")} artifacts`);
  return scope.length > 0 ? `${query} (${scope.join("; ")})` : query;
}

async function executeDeveloper(input: DeveloperInput, signal?: AbortSignal) {
  const limit = boundedLimit(input.limit);
  const raw = await runFirecrawl(["developer", developerQuery(input), "--limit", String(limit), "--json"], signal);
  const response = parseJson(raw, "developer search");
  const rawResults = Array.isArray(response.results) ? response.results : [];
  const results = rawResults
    .filter(isObject)
    .map((item) => {
      const type = developerType(item.id, item.type);
      const passages = Array.isArray(item.passages) ? item.passages : [];
      const passage = passages.length > 0 && isObject(passages[0]) ? passages[0].text : item.description;
      return {
        type,
        title: clip(item.title, 220) || "(untitled)",
        url: typeof item.url === "string" ? item.url : "",
        passage: clip(passage, MAX_PASSAGE_CHARS) || "(no matched passage)",
      };
    })
    .filter((item) => item.url.length > 0)
    .filter((item) => !input.type || item.type === input.type)
    .slice(0, limit);

  return textResult({ results });
}

async function executeQuestion(input: QuestionInput, signal?: AbortSignal) {
  const url = requiredText(input.url, "url", 4_000);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("url must be a valid HTTP(S) URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("url must use HTTP or HTTPS");
  }
  const question = requiredText(input.question, "question", 2_000);
  const raw = await runFirecrawl([
    "scrape", url, "--query", question, "--format", "json", "--schema", FOCUSED_FALLBACK_SCHEMA,
    "--only-main-content",
  ], signal);
  let answer = raw.trim();
  if (answer.startsWith("{") || answer.startsWith("[")) {
    const response = parseJson(answer, "focused question");
    answer = typeof response.answer === "string" ? response.answer.trim() : "";
  }
  answer = clip(answer, MAX_QUESTION_CHARS);
  if (!answer) throw new Error("Firecrawl returned no focused answer");
  return textResult({ answer, source: url });
}

function recencyFlag(recency: SearchInput["recency"]): string | undefined {
  if (!recency) return undefined;
  return `qdr:${recency === "day" ? "d" : recency === "week" ? "w" : recency === "month" ? "m" : "y"}`;
}

async function executeSearch(input: SearchInput, signal?: AbortSignal) {
  const query = requiredText(input.query, "query");
  const limit = boundedLimit(input.limit);
  const args = ["search", query, "--limit", String(limit), "--highlights", "--json"];
  if (input.source) args.push("--sources", input.source);
  if (input.category) args.push("--categories", input.category);
  const tbs = recencyFlag(input.recency);
  if (tbs) args.push("--tbs", tbs);

  const response = parseJson(await runFirecrawl(args, signal), "search");
  const data = isObject(response.data) ? response.data : response;
  const groups: Array<{ source: string; values: unknown[] }> = [];
  const groupValues = {
    web: Array.isArray(data.web) ? data.web : [],
    news: Array.isArray(data.news) ? data.news : [],
    developer: Array.isArray(data.developer) ? data.developer : [],
  };
  const groupOrder = input.category === "developer" ? ["developer", "web", "news"] : ["web", "news", "developer"];
  for (const source of groupOrder) {
    const values = groupValues[source as keyof typeof groupValues];
    if (values.length > 0) groups.push({ source, values });
  }
  const results = groups.flatMap(({ source, values }) => values.filter(isObject).map((item) => ({
    source,
    title: clip(item.title, 220) || "(untitled)",
    url: typeof item.url === "string" ? item.url : "",
    snippet: clip(item.description ?? item.snippet, MAX_PASSAGE_CHARS) || "(no snippet)",
  }))).filter((item) => item.url.length > 0).slice(0, limit);

  return textResult({ results });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "firecrawl_developer",
    label: "Firecrawl Developer",
    description: "Search developer docs, READMEs, issues, and PRs; return matched passages.",
    parameters: DeveloperParameters,
    async execute(_toolCallId, params, signal) {
      return executeDeveloper(params as DeveloperInput, signal);
    },
  });

  pi.registerTool({
    name: "firecrawl_question",
    label: "Firecrawl Question",
    description: "Answer one fact question from a known URL; no page Markdown.",
    parameters: QuestionParameters,
    async execute(_toolCallId, params, signal) {
      return executeQuestion(params as QuestionInput, signal);
    },
  });

  pi.registerTool({
    name: "firecrawl_search",
    label: "Firecrawl Search",
    description: "Search Firecrawl with source/category/recency controls; return snippets.",
    parameters: SearchParameters,
    async execute(_toolCallId, params, signal) {
      return executeSearch(params as SearchInput, signal);
    },
  });
}
