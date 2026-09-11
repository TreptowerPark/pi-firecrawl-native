import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const FIRECRAWL_COMMAND = process.env.PI_FIRECRAWL_COMMAND || "firecrawl";
const FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const MAX_CLI_OUTPUT_BYTES = 2_000_000;
const MAX_PASSAGE_CHARS = 650;
const MAX_QUESTION_CHARS = 4_000;
const MAX_ERROR_CHARS = 240;
const REQUEST_TIMEOUT_MS = 120_000;
const DNS_TIMEOUT_MS = 10_000;

const DEVELOPER_TYPES = ["doc", "readme", "issue", "pull_request"] as const;
const REPOSITORY_DEVELOPER_TYPES = ["readme", "issue", "pull_request"] as const;
const SEARCH_SOURCES = ["web", "news"] as const;
const SEARCH_CATEGORIES = ["github", "developer", "research", "pdf"] as const;
const RECENCY_VALUES = ["day", "week", "month", "year"] as const;

export const DeveloperParameters = Type.Object({
  query: Type.String({ description: "Developer query" }),
  repo: Type.Optional(Type.String({ description: "GitHub repo for README, issues, and PRs" })),
  type: Type.Optional(StringEnum(DEVELOPER_TYPES, { description: "One artifact type" })),
  limit: Type.Optional(Type.Integer({ description: "Max results", minimum: 1, maximum: MAX_LIMIT })),
});

export const QuestionParameters = Type.Object({
  url: Type.String({ description: "Known public HTTP(S) URL" }),
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
type ClippedText = { text: string; truncated: boolean };
type FirecrawlCredentials = { apiKey?: string; apiUrl: string };
type DeveloperScope = {
  repo?: string;
  types?: readonly (typeof DEVELOPER_TYPES)[number][];
  direct: boolean;
};

const IPV4_NON_PUBLIC_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV6_NON_PUBLIC_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["::", 96],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:30::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function cleanMultilineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b(?:\][\s\S]*?(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[()#%][0-2AB]|[=>78])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
}

function cleanInlineText(value: unknown): string {
  return cleanMultilineText(value).replace(/\s+/g, " ").trim();
}

function clipMultiline(value: unknown, maxChars: number): ClippedText {
  const text = cleanMultilineText(value);
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars - 1)}…`, truncated: true };
}

function clipInline(value: unknown, maxChars: number): ClippedText {
  const text = cleanInlineText(value);
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars - 1).trimEnd()}…`, truncated: true };
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

function safeDiagnostic(_stderr: string, code: number | null): string {
  return `Firecrawl request failed (exit ${code ?? "unknown"})`.slice(0, MAX_ERROR_CHARS);
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
    child.on("error", () => finish(new Error("Unable to run Firecrawl")));
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

function credentialsPath(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "firecrawl-cli", "credentials.json");
  if (process.platform === "win32") return join(homedir(), "AppData", "Roaming", "firecrawl-cli", "credentials.json");
  return join(homedir(), ".config", "firecrawl-cli", "credentials.json");
}

async function firecrawlCredentials(): Promise<FirecrawlCredentials> {
  let stored: JsonObject | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(credentialsPath(), "utf8"));
    if (isObject(parsed)) stored = parsed;
  } catch {
    // The CLI can operate keylessly; an absent or unreadable store is not an error.
  }

  const storedKey = typeof stored?.apiKey === "string" ? stored.apiKey : undefined;
  const storedUrl = typeof stored?.apiUrl === "string" ? stored.apiUrl : undefined;
  const apiKey = process.env.FIRECRAWL_API_KEY || storedKey;
  const apiUrl = process.env.FIRECRAWL_API_URL || storedUrl || FIRECRAWL_API_URL;
  try {
    const parsed = new URL(apiUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("invalid API URL");
    }
  } catch {
    throw new Error("Firecrawl API configuration is invalid");
  }
  return { apiKey, apiUrl: apiUrl.replace(/\/+$/, "") };
}

function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl}${path}`;
}

async function readBoundedResponseBody(response: Response, controller: AbortController): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let outputBytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outputBytes += value.byteLength;
      if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // Aborting can close the stream before cancellation completes.
        }
        throw new Error("Firecrawl response exceeded the safety limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function requestFirecrawlJson(
  path: string,
  method: "GET" | "POST",
  body: JsonObject | undefined,
  label: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  if (signal?.aborted) throw new Error("Firecrawl request cancelled");
  const credentials = await firecrawlCredentials();
  if (signal?.aborted) throw new Error("Firecrawl request cancelled");

  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (credentials.apiKey) headers.Authorization = `Bearer ${credentials.apiKey}`;
    const response = await fetch(apiEndpoint(credentials.apiUrl, path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await readBoundedResponseBody(response, controller);
    if (!response.ok) throw new Error(`Firecrawl ${label} request failed (HTTP ${response.status})`);
    return parseJson(raw, label);
  } catch (error) {
    if (signal?.aborted) throw new Error("Firecrawl request cancelled");
    if (timedOut) throw new Error("Firecrawl request timed out");
    if (error instanceof Error && error.message === "Firecrawl response exceeded the safety limit") throw error;
    if (error instanceof Error && /^Firecrawl .* request failed \(HTTP \d+\)$/.test(error.message)) throw error;
    if (error instanceof Error && error.message.endsWith("returned invalid JSON")) throw error;
    throw new Error(`Firecrawl ${label} request failed`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function developerType(id: unknown): (typeof DEVELOPER_TYPES)[number] {
  const prefix = typeof id === "string" ? id.split(":", 1)[0] : "";
  if ((DEVELOPER_TYPES as readonly string[]).includes(prefix)) {
    return prefix as (typeof DEVELOPER_TYPES)[number];
  }
  throw new Error("Firecrawl developer search returned an unexpected artifact");
}

function normalizeRepo(value: unknown): string {
  const repo = requiredText(value, "repo", 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo)) {
    throw new Error("repo must be a GitHub owner/name");
  }
  return repo;
}

function developerScope(input: DeveloperInput): DeveloperScope {
  const repo = input.repo === undefined ? undefined : normalizeRepo(input.repo);
  if (repo && input.type === "doc") {
    throw new Error("Documentation sources cannot be scoped by repository; a documentation source ID is required");
  }
  if (input.type) return { repo, types: [input.type], direct: true };
  if (repo) return { repo, types: REPOSITORY_DEVELOPER_TYPES, direct: true };
  return { direct: false };
}

function assertDeveloperSuccess(response: JsonObject): void {
  if (response.success !== true) throw new Error("Firecrawl developer search failed");
  if (response.results !== undefined && !Array.isArray(response.results)) {
    throw new Error("Firecrawl developer search returned an invalid response");
  }
}

function developerResults(response: JsonObject, limit: number, scope: DeveloperScope) {
  const rawResults = response.results === undefined ? [] : response.results;
  if (!Array.isArray(rawResults) || rawResults.length > limit) {
    throw new Error("Firecrawl developer search returned an unexpected result count");
  }

  return rawResults.map((item) => {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.url !== "string") {
      throw new Error("Firecrawl developer search returned an invalid result");
    }
    const type = developerType(item.id);
    if (scope.types && !scope.types.includes(type)) {
      throw new Error("Firecrawl developer search returned results outside the requested scope");
    }
    const passages = item.passages;
    if (passages !== undefined && !Array.isArray(passages)) {
      throw new Error("Firecrawl developer search returned an invalid passage list");
    }
    const firstPassage = passages?.[0];
    if (firstPassage !== undefined && (!isObject(firstPassage) || typeof firstPassage.text !== "string")) {
      throw new Error("Firecrawl developer search returned an invalid passage");
    }

    const title = clipInline(item.title, 220);
    const url = clipInline(redactSensitiveUrl(item.url), 4_000);
    const passage = firstPassage ? clipMultiline(firstPassage.text, MAX_PASSAGE_CHARS) : { text: "(no matched passage)", truncated: false };
    const truncated = title.truncated || url.truncated || passage.truncated;
    return {
      type,
      title: title.text || "(untitled)",
      url: url.text,
      passage: passage.text,
      ...(truncated ? { truncated: true } : {}),
    };
  });
}

function repoScopeStatus(response: JsonObject, repo: string): { repo: string; indexed: boolean } {
  if (!Array.isArray(response.repos)) {
    throw new Error("Firecrawl developer search did not confirm the repository scope");
  }
  const status = response.repos.find((item) => isObject(item)
    && typeof item.repo === "string"
    && item.repo.toLowerCase() === repo.toLowerCase());
  if (!status || typeof status.indexed !== "boolean") {
    throw new Error("Firecrawl developer search did not confirm the repository scope");
  }
  return { repo, indexed: status.indexed };
}

async function executeDeveloper(input: DeveloperInput, signal?: AbortSignal) {
  const query = requiredText(input.query, "query");
  const limit = boundedLimit(input.limit);
  const scope = developerScope(input);
  let response: JsonObject;

  if (scope.direct) {
    const params = new URLSearchParams({ query, k: String(limit), passages: "1" });
    for (const type of scope.types ?? []) params.append("types", type);
    if (scope.repo) params.append("repos", scope.repo);
    response = await requestFirecrawlJson(`/v2/search/developer?${params.toString()}`, "GET", undefined, "developer search", signal);
  } else {
    response = parseJson(await runFirecrawl(["developer", query, "--limit", String(limit), "--json"], signal), "developer search");
  }

  assertDeveloperSuccess(response);
  const results = developerResults(response, limit, scope);
  const scopeResult = scope.repo ? repoScopeStatus(response, scope.repo) : undefined;
  return textResult({ results, ...(scopeResult ? { scope: scopeResult } : {}) });
}

function parseIPv4(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(value: string, network: string, prefix: number): boolean {
  const address = parseIPv4(value);
  const base = parseIPv4(network);
  if (address === undefined || base === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (base & mask);
}

function parseIPv6(value: string): bigint | undefined {
  let address = value.replace(/^\[|\]$/g, "").toLowerCase();
  const embeddedIpv4Start = address.lastIndexOf(":");
  if (address.includes(".") && embeddedIpv4Start >= 0) {
    const embeddedIpv4 = parseIPv4(address.slice(embeddedIpv4Start + 1));
    if (embeddedIpv4 === undefined) return undefined;
    address = `${address.slice(0, embeddedIpv4Start + 1)}${(embeddedIpv4 >>> 16).toString(16)}:${(embeddedIpv4 & 0xffff).toString(16)}`;
  }
  if (isIP(address) !== 6) return undefined;
  const [head = "", tail = "", ...extra] = address.split("::");
  if (extra.length > 0) return undefined;
  const expand = (part: string): string[] => part ? part.split(":") : [];
  const headParts = expand(head);
  const tailParts = expand(tail);
  if (headParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || tailParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }
  const hasCompression = address.includes("::");
  const zeroParts = 8 - headParts.length - tailParts.length;
  if ((!hasCompression && zeroParts !== 0) || (hasCompression && zeroParts < 1)) return undefined;
  const parts = [...headParts, ...Array(zeroParts).fill("0"), ...tailParts];
  if (parts.length !== 8) return undefined;
  return parts.reduce((result, part) => (result << 16n) + BigInt(`0x${part}`), 0n);
}

function ipv6InCidr(value: string, network: string, prefix: number): boolean {
  const address = parseIPv6(value);
  const base = parseIPv6(network);
  if (address === undefined || base === undefined) return false;
  const shift = BigInt(128 - prefix);
  return (address >> shift) === (base >> shift);
}

function isPublicIp(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !IPV4_NON_PUBLIC_CIDRS.some(([network, prefix]) => ipv4InCidr(value, network, prefix));
  if (family !== 6) return false;

  if (ipv6InCidr(value, "::ffff:0:0", 96)) {
    const parsed = parseIPv6(value);
    if (parsed === undefined) return false;
    const mapped = Number(parsed & 0xffffffffn);
    const ipv4 = `${(mapped >>> 24) & 255}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
    return isPublicIp(ipv4);
  }
  if (!ipv6InCidr(value, "2000::", 3)) return false;
  return !IPV6_NON_PUBLIC_CIDRS.some(([network, prefix]) => ipv6InCidr(value, network, prefix));
}

function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "local" || name.endsWith(".local") || !name.includes(".");
}

type ResolvedAddress = { address: string; family: number };

function lookupPublicHost(hostname: string, signal?: AbortSignal): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Firecrawl request cancelled"));
      return;
    }
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(new Error("Firecrawl request cancelled")));
    const timer = setTimeout(() => finish(() => reject(new Error("url host validation timed out"))), DNS_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => finish(() => resolve(addresses)),
      () => finish(() => reject(new Error("url host could not be resolved"))),
    );
  });
}

async function validatePublicQuestionUrl(value: unknown, signal?: AbortSignal): Promise<URL> {
  const rawUrl = requiredText(value, "url", 4_000);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("url must not include credentials");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  if (!hostname || (family === 0 && isLocalHostname(hostname))) {
    throw new Error("url host must be public");
  }
  if (family !== 0) {
    if (!isPublicIp(hostname)) throw new Error("url host must be public");
    return parsed;
  }

  const addresses = await lookupPublicHost(hostname, signal);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address.address))) {
    throw new Error("url host must resolve only to public IP addresses");
  }
  return parsed;
}

function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const [name] of url.searchParams) {
      if (/(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|credential|key|pass(?:word|wd)?|secret|session|signature|sig|token|code)/i.test(name)) {
        url.searchParams.set(name, "redacted");
      }
    }
    return url.toString();
  } catch {
    return cleanInlineText(value);
  }
}

async function executeQuestion(input: QuestionInput, signal?: AbortSignal) {
  const url = await validatePublicQuestionUrl(input.url, signal);
  const question = requiredText(input.question, "question", 2_000);
  const response = await requestFirecrawlJson("/v2/scrape", "POST", {
    url: url.toString(),
    formats: [{ type: "question", question }],
    onlyMainContent: true,
  }, "focused question", signal);
  const data = response.data;
  if (response.success !== true || !isObject(data) || typeof data.answer !== "string") {
    throw new Error("Firecrawl returned no structured focused answer");
  }

  const answer = clipMultiline(data.answer, MAX_QUESTION_CHARS);
  if (!answer.text.trim()) throw new Error("Firecrawl returned no focused answer");
  return textResult({
    answer: answer.text,
    source: redactSensitiveUrl(url.toString()),
    answer_type: "generated_summary",
    evidence: "not independently verified",
    ...(answer.truncated ? { truncated: true } : {}),
  });
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
  if (response.success !== true) throw new Error("Firecrawl search failed");
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
  const results = groups.flatMap(({ source, values }) => values.filter(isObject).map((item) => {
    const title = clipInline(item.title, 220);
    const url = clipInline(redactSensitiveUrl(typeof item.url === "string" ? item.url : ""), 4_000);
    const snippet = clipMultiline(item.description ?? item.snippet, MAX_PASSAGE_CHARS);
    const truncated = title.truncated || url.truncated || snippet.truncated;
    return {
      source,
      title: title.text || "(untitled)",
      url: url.text,
      snippet: snippet.text || "(no snippet)",
      ...(truncated ? { truncated: true } : {}),
    };
  })).filter((item) => item.url.length > 0).slice(0, limit);

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
    description: "Answer one fact question from a known public URL; no page Markdown.",
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
