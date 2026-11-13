// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves and fetches module graphs using import maps and shared script-gate checks.

import {
  MAX_RECORDED_RESOLUTIONS,
  importMapModuleSource,
  mergeImportMap,
  newImportMapBudget,
  parseDocumentImportMap,
  resolveImportMapSpecifier,
  resolvedModuleRecord,
  type ParsedImportMap,
  type ResolvedModuleRecord,
} from "@kitesurf/script-gate/import-map";
export {
  FALLBACK_MODULE_RESOLVER_SOURCE,
  ImportMapBudgetError,
  MAX_IMPORT_MAP_ENTRIES,
  MAX_IMPORT_MAP_SCOPES,
  MAX_IMPORT_MAP_SOURCE_BYTES,
  MAX_IMPORT_MAP_KEY_CODE_UNITS,
  MAX_RECORDED_RESOLUTIONS,
  MAX_IMPORT_MAP_WORK,
  importMapModuleSource,
  mergeImportMap,
  parseImportMap,
  parseImportMaps,
  resolveImportMapSpecifier,
  resolvedModuleRecord,
  type ImportMapBudget,
  type ParsedImportMap,
  type ResolvedModuleRecord,
} from "@kitesurf/script-gate/import-map";

import { parse as lexerParse } from "es-module-lexer/js";
import {
  checkScriptBeforeFetch,
  checkScriptRedirect,
  checkScriptResponse,
  type ModuleType,
  type ScriptGateContext,
} from "@kitesurf/script-gate";
import { KITESURF_NOSNIFF_HEADER } from "@kitesurf/script-gate/gateway-headers";
import type { ParentScriptDescriptor, ScannedModulePreload } from "../wasm.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import { scriptCredentialsMode } from "./cors.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { htmlTagSpans } from "./html-tag-spans.ts";
import { walkRedirects } from "./redirect-walk.ts";
import { MAX_DOCUMENT_BYTES, readCapped } from "../read-capped.ts";

// Page modules are baked under http(s) urls. Any other scheme names the loaded worker's own
// registry (file:///bundle/, cloudflare:, node:), which page code must never link to.
function isPageModuleUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

function inlineModuleUrl(pageUrl: string, index: number): string {
  try {
    const url = new URL(`__kitesurf_inline_${index}.js`, pageUrl).toString();
    if (isPageModuleUrl(url)) return url;
  } catch {}
  return `https://kitesurf-inline.invalid/${index}.js`;
}

function pageOriginFromUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.protocol + "//" + u.host;
  } catch {
    return "";
  }
}

function resolveAgainstImporter(specifier: string, importer: string): string | null {
  try {
    return new URL(specifier, importer).toString();
  } catch {
    return null;
  }
}

function isUrlLikeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)
  );
}

type LexedImport = ReturnType<typeof lexerParse>[0][number];

// A dynamic import's whole argument list, verbatim. Its options carry the requested module
// type, so the runtime loader has to receive them unchanged.
function dynamicImportArguments(body: string, imp: LexedImport): string {
  return body.slice(imp.d + 1, imp.se - 1);
}

function dynamicImportExpression(body: string, imp: LexedImport): string {
  if (imp.a < 0) return body.slice(imp.d + 1, imp.se - 1);
  const withSeparator = body.slice(imp.d + 1, imp.a);
  return withSeparator.slice(0, withSeparator.lastIndexOf(","));
}

// One dynamic import as a runtime-loader call. Without options only the specifier is passed,
// as before; with options the whole argument list is forwarded, so nothing is evaluated twice
// and the requested module type reaches the loader. `spec` is the extracted literal, when any.
function runtimeImportCall(body: string, imp: LexedImport, ref: string, spec?: string): string {
  if (imp.a >= 0) {
    return `((s, o) => __ks_import(s, ${ref}, o))(${dynamicImportArguments(body, imp)})`;
  }
  const first = spec === undefined ? dynamicImportExpression(body, imp) : JSON.stringify(spec);
  return `__ks_import(${first}, ${ref})`;
}

function nativelyResolvesTo(specifier: string, importer: string, target: string): boolean {
  return resolveAgainstImporter(specifier, importer) === target;
}

function constSpecifier(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 2) return null;
  const q = s[0];
  if ((q === '"' || q === "'" || q === "`") && s[s.length - 1] === q) {
    const inner = s.slice(1, -1);
    if (inner.includes("${") || inner.includes("\\") || inner.includes(q)) return null;
    return inner;
  }
  return null;
}

function importMetaResolveEnd(
  source: string,
  imp: ReturnType<typeof lexerParse>[0][number],
): number | null {
  const match = /^(?:\s*\.\s*resolve\b|\s*\[\s*(["'])resolve\1\s*\])/.exec(source.slice(imp.se));
  return match ? imp.se + match[0].length : null;
}

export function rewriteImportMetaResolve(
  expression: string,
  importer: string,
  syntheticImportMeta?: string,
): string {
  const replacement = `((specifier) => globalThis.__ks_resolve_import_map(specifier, ${JSON.stringify(importer)}))`;
  let imports: ReturnType<typeof lexerParse>[0];
  try {
    imports = lexerParse(expression)[0];
  } catch {
    return expression;
  }
  const rewrites: Array<{ start: number; end: number; text: string }> = [];
  for (const imp of imports) {
    if (imp.t !== 3) continue;
    if (syntheticImportMeta) {
      rewrites.push({ start: imp.ss, end: imp.se, text: syntheticImportMeta });
      continue;
    }
    const end = importMetaResolveEnd(expression, imp);
    if (end !== null) {
      rewrites.push({ start: imp.ss, end, text: replacement });
    }
  }
  let rewritten = expression;
  for (const rewrite of rewrites.reverse()) {
    rewritten = rewritten.slice(0, rewrite.start) + rewrite.text + rewritten.slice(rewrite.end);
  }
  return rewritten;
}

export function assignModuleRegistryNames(urls: Iterable<string>): Map<string, string> {
  const allUrls = [...urls];
  const groups = new Map<string, string[]>();
  for (const url of allUrls) {
    let identity = url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      parsed.search = "";
      parsed.hash = "";
      identity = parsed.href;
    } catch {
      continue;
    }
    const group = groups.get(identity) ?? [];
    group.push(url);
    groups.set(identity, group);
  }

  const names = new Map<string, string>();
  const occupied = new Set(allUrls);
  for (const [identity, group] of groups) {
    // workerd drops the query from a module name, so even a lone ?query record would take the
    // bare url's name, where an import of the bare url that was not baked would find it.
    if (group.length < 2 && group[0] === identity) continue;
    const base = new URL(identity);
    const match = /^(.*?)(\.[^./]+)$/.exec(base.pathname);
    const stem = match?.[1] ?? base.pathname;
    const extension = match?.[2] ?? ".js";
    for (const [index, url] of group.entries()) {
      let candidate: string;
      let suffix = index;
      do {
        base.pathname = `${stem}.__ks_query_${suffix}${extension}`;
        candidate = base.href;
        suffix++;
      } while (occupied.has(candidate));
      occupied.add(candidate);
      names.set(url, candidate);
    }
  }
  return names;
}

export function astroIslandModuleUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const [start, end] of htmlTagSpans(html, "astro-island", false)) {
    let i = start;
    while (i < end) {
      if (!/\s/.test(html[i] ?? "")) {
        i++;
        continue;
      }
      const at = i + 1;
      const component = 'component-url="';
      const renderer = 'renderer-url="';
      const rest = html.slice(at, Math.min(end, at + component.length)).toLowerCase();
      const prefix = rest.startsWith(component)
        ? component
        : rest.startsWith(renderer)
          ? renderer
          : null;
      if (!prefix) {
        i++;
        continue;
      }
      const valueStart = at + prefix.length;
      const close = html.indexOf('"', valueStart);
      if (close < 0 || close >= end) break;
      const raw = html.slice(valueStart, close);
      if (raw) {
        const url = resolveAgainstImporter(raw.replace(/&amp;/g, "&"), baseUrl);
        if (url && /^https?:\/\//.test(url)) urls.add(url);
      }
      i = close + 1;
    }
  }
  return [...urls];
}

export interface ModulePreloadSeed {
  url: string;
  nonce: string | null;
  integrity: string | null;
  crossOrigin?: string | null;
}

export function modulePreloadSeeds(
  links: readonly ScannedModulePreload[],
  baseUrl: string,
): ModulePreloadSeed[] {
  const seeds = new Map<string, Omit<ModulePreloadSeed, "url">>();
  for (const { href, nonce, integrity, crossOrigin } of links) {
    const url = resolveAgainstImporter(href, baseUrl);
    if (url && /^https?:\/\//.test(url) && !seeds.has(url)) {
      seeds.set(url, { nonce, integrity, ...(crossOrigin == null ? {} : { crossOrigin }) });
    }
  }
  return [...seeds].map(([url, seed]) => ({ url, ...seed }));
}

// Every `import` that can start a call: not after a name or a dot on the same line (`...` spreads),
// and comments may precede the `(`. Matches in strings and comments only cost a fallback; a miss
// leaves a native import(), so a dot that ends an earlier line, as in a comment, does not count.
// Each comment matches one way, to its first `*/` or line end, so failing scans stay linear.
const IMPORT_CALL =
  /(?<![\p{ID_Continue}$#\u200c\u200d]|(?<!\.\.)\.[^\S\n\r\u2028\u2029]*)import(?=(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|(?:\/\/|<!--|-->)[^\n\r\u2028\u2029]*(?![^\n\r\u2028\u2029]))*\()/gu;

// IMPORT_CALL skips a dot only on the same line. A dot that ends an earlier line is still a member
// access, unless a line comment holds it: a block comment or string would also hold the import.
// A number (`1.`) or a spread (`...`) before the newline does not make one.
function afterMemberDot(body: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(body[i] ?? "")) i--;
  if (body[i] !== "." || /[\d.]/.test(body[i - 1] ?? "")) return false;
  const lineStart = Math.max(
    ...["\n", "\r", "\u2028", "\u2029"].map((c) => body.lastIndexOf(c, i)),
  );
  const line = body.slice(lineStart + 1, i);
  // `-->` at the start of a line is a line comment too, and IMPORT_CALL already reads it as one.
  return !/\/\/|<!--|-->/.test(line);
}

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Offset just past a leading directive prologue, so a statement can be inserted there without
// turning `"use strict"` into a plain expression statement and dropping strict mode. Linear, and
// it gives up at anything that is not a string-literal statement.
function afterDirectivePrologue(body: string): number {
  const n = body.length;
  let i = 0;
  let end = 0;
  const skipTrivia = (): void => {
    for (;;) {
      const c = body[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i += 1;
        continue;
      }
      if (c === "/" && body[i + 1] === "/") {
        while (i < n && body[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && body[i + 1] === "*") {
        const close = body.indexOf("*/", i + 2);
        i = close < 0 ? n : close + 2;
        continue;
      }
      return;
    }
  };
  for (;;) {
    skipTrivia();
    const quote = body[i];
    if (quote !== '"' && quote !== "'") return end;
    i += 1;
    let closed = false;
    while (i < n) {
      const c = body[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n" || c === "\r") break;
      if (c === quote) {
        i += 1;
        closed = true;
        break;
      }
      i += 1;
    }
    // A string that runs to the line end is not a directive.
    if (!closed) return end;
    while (body[i] === " " || body[i] === "\t") i += 1;
    if (body[i] === ";") {
      i += 1;
      end = i;
      continue;
    }
    // No semicolon: only a line break ends the statement, otherwise the string continues an
    // expression (`"use strict".length`) and no prologue is in play.
    if (i >= n || body[i] === "\n" || body[i] === "\r") {
      end = i;
      continue;
    }
    return end;
  }
}

export function extractClassicDynamicSeeds(
  body: string,
  baseUrl: string,
  resolveSpecifier: (specifier: string, importer: string) => string | null = (
    specifier,
    importer,
  ) => (isUrlLikeSpecifier(specifier) ? resolveAgainstImporter(specifier, importer) : null),
  // The caller names the binding so that scripts sharing a bundle scope never collide.
  callee: string = `__ks_import_${fnv1aHex(baseUrl)}`,
): { rewritten: string; seeds: string[] } {
  const calls = [...body.matchAll(IMPORT_CALL)]
    .map((m) => m.index)
    .filter((at) => !afterMemberDot(body, at));
  if (calls.length === 0) return { rewritten: body, seeds: [] };
  // The lexer is not a parser: it can throw on valid code, or misread a regex and skip live code.
  // A native import() left in the bundle resolves next to the isolate's own modules, so a call
  // the lexer did not see goes to the runtime loader. Text in a comment or string costs the same.
  let imports: ReturnType<typeof lexerParse>[0] | null = null;
  try {
    imports = lexerParse(body, baseUrl)[0];
  } catch {}
  const dynamics = imports?.filter((imp) => imp.t === 2) ?? [];
  const lexedCalls = new Set(dynamics.map((imp) => imp.ss));
  const unlexed = calls.filter((at) => !lexedCalls.has(at));
  const ref = JSON.stringify(baseUrl);
  // Only the keyword is replaced, so a hoisted function per script url passes it as the referrer.
  // A name keeps a method called `import` valid; scripts in one bundle share a scope.
  const binding = `\nfunction ${callee}(s, o) { return __ks_import(s, ${ref}, o); }`;
  // The helper is a bundle-scope function, so a script the page inserts later cannot see it, and
  // renaming `import` inside a string the page builds a script from would leave that script calling
  // a name it cannot reach. Publish the helper on globalThis, which boa shares with the page realm,
  // so the inserted script calls it and reaches `__ks_import`, which refuses file:///bundle/.
  const publish = `globalThis.${callee} ??= ${callee};\n`;
  // The declaration is hoisted, so the publish can precede it. It goes after any directive
  // prologue: a statement before one would turn `"use strict"` into a plain expression.
  const withHelper = (text: string): string => {
    const at = afterDirectivePrologue(text);
    const lead = at > 0 ? "\n" : "";
    return text.slice(0, at) + lead + publish + text.slice(at) + binding;
  };
  // A lexed call is rewritten as a whole, so one that holds another call would drop its edit.
  const inner = [...unlexed, ...lexedCalls];
  const nested = dynamics.some(
    (imp) => imp.se <= imp.ss || inner.some((at) => at > imp.ss && at < imp.se),
  );
  if (!imports || nested) {
    const keep = new Set(calls);
    const rewritten = body.replace(IMPORT_CALL, (m, at: number) => (keep.has(at) ? callee : m));
    return { rewritten: withHelper(rewritten), seeds: [] };
  }
  const edits = [
    ...dynamics.map((imp) => ({ at: imp.ss, imp })),
    ...unlexed.map((at) => ({ at, imp: null })),
  ].sort((a, c) => c.at - a.at);
  const seeds: string[] = [];
  // One replacement per call site, joined once: repeating the base at every site grows with the
  // page's import count, and splicing the body per edit copies the rest of it each time.
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let usesCallee = false;
  for (const { at, imp } of edits) {
    if (!imp) {
      replacements.push({ start: at, end: at + "import".length, text: callee });
      usesCallee = true;
      continue;
    }
    const spec = imp.n ?? constSpecifier(body.slice(imp.s, imp.e));
    if (spec) {
      const resolved = resolveSpecifier(spec, baseUrl);
      if (!resolved || (!isPageModuleUrl(resolved) && !resolved.startsWith("data:"))) {
        // With options the whole argument list goes through, so the requested type reaches the
        // loader and nothing is evaluated twice.
        const args = imp.a < 0 ? JSON.stringify(spec) : dynamicImportArguments(body, imp);
        replacements.push({ start: imp.ss, end: imp.se, text: `${callee}(${args})` });
        usesCallee = true;
        continue;
      }
      if (isPageModuleUrl(resolved)) seeds.push(resolved);
      replacements.push({ start: imp.s, end: imp.e, text: JSON.stringify(resolved) });
      continue;
    }
    if (imp.d > -1) {
      const args = dynamicImportArguments(body, imp);
      replacements.push({ start: imp.ss, end: imp.se, text: `${callee}(${args})` });
      usesCallee = true;
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end, text } of replacements.reverse()) {
    parts.push(body.slice(cursor, start), text);
    cursor = end;
  }
  parts.push(body.slice(cursor));
  const rewritten = parts.join("");
  if (!usesCallee) return { rewritten, seeds };
  return { rewritten: unlexed.length > 0 ? withHelper(rewritten) : rewritten + binding, seeds };
}

function maybeWrapInlineModule(body: string, url: string): string {
  if (!/\bawait\b/.test(body)) return body;

  let parsed: ReturnType<typeof lexerParse>;
  try {
    parsed = lexerParse(body, url);
  } catch {
    return body;
  }
  const imports = parsed[0];
  const exports = parsed[1];

  if (exports.length > 0) return body;

  if (imports.length === 0) {
    return ";(async () => {\n" + body + "\n})();\n";
  }

  const importStmts: string[] = [];
  let remainder = "";
  let cursor = 0;
  for (const imp of imports) {
    if (imp.t !== 1) continue;
    remainder += body.slice(cursor, imp.ss);
    importStmts.push(body.slice(imp.ss, imp.se));
    cursor = imp.se;
    if (body[cursor] === ";") cursor++;
  }
  remainder += body.slice(cursor);

  return importStmts.join(";\n") + ";\n;(async () => {\n" + remainder + "\n})();\n";
}

function isAssetExtension(url: string): boolean {
  let path = url;
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  const h = path.indexOf("#");
  if (h >= 0) path = path.slice(0, h);
  return /\.(css|svg|png|jpe?g|gif|webp|woff2?|ttf|eot|ico|avif)$/i.test(path);
}

export type BakedModule = string | { json: unknown };

const MAX_MODULES = 1000;

const BAKE_BUDGET_BYTES = 40 * 1024 * 1024;

const MAX_DYNAMIC_MODULE_BYTES = 4 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 10_000;
const MODULE_FETCH_RETRY_BASE_DELAY_MS = 150;
const MODULE_FETCH_RETRY_JITTER_RATIO = 0.5;
const BYTES_PER_MIB = 1_048_576;

const WALK_CONCURRENCY = 8;

const WALK_DEADLINE_MS = 1_000;

const FANOUT_REGISTRY_THRESHOLD = 8;

export function chunkBaseName(url: string): string | null {
  let file: string;
  try {
    file = new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return null;
  }
  const stem = file.replace(/(?:\.chunk)?\.m?js$/i, "");
  const m = /^(.+)[-.]([A-Za-z0-9_-]{8}|[a-f0-9]{9,32})$/.exec(stem);
  const hash = m?.[2] ?? "";
  const hashed = /\d/.test(hash) || (/[a-z]/.test(hash) && /[A-Z]/.test(hash.slice(1)));
  const name = m?.[1] && hashed ? m[1] : stem;
  return name.length >= 4 && /[A-Za-z]/.test(name) ? name : null;
}

const MAX_TOKENIZED_HTML = 4 * 1024 * 1024;

export function documentTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  if (html.length > MAX_TOKENIZED_HTML) return tokens;
  for (const m of html.matchAll(/[A-Za-z_$][\w$-]{3,}/g)) tokens.add(m[0]);
  return tokens;
}

export interface WalkResult {
  descriptors: ParentScriptDescriptor[];
  insertedDescriptors: ParentScriptDescriptor[];
  additionalModules: Record<string, BakedModule>;
  importMapModuleSource: string;
}

interface WalkModuleGraphInput {
  descriptors: ParentScriptDescriptor[];
  insertedDescriptors?: readonly ParentScriptDescriptor[];
  pageUrl: string;
  connectionId: string;
  mainFrameId?: string;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  cookieKey?: string;
  options?: {
    baseUrl?: string;
    gate?: ScriptGateContext;
    importMaps?: readonly { source: string; baseUrl: string; scriptDomIndex: number }[];
    moduleSeeds?: readonly string[];
    preloadSeeds?: readonly ModulePreloadSeed[];
    documentHtml?: string;
  };
  sandboxOutbound: SandboxOutboundOverride;
}

export async function walkModuleGraph({
  descriptors,
  insertedDescriptors = [],
  pageUrl,
  connectionId,
  mainFrameId = "",
  mainLoaderId = "",
  extraHeaders = {},
  cookieKey = "",
  options: opts = {},
  sandboxOutbound,
}: WalkModuleGraphInput): Promise<WalkResult> {
  const out = descriptors.map((d) => ({ ...d }));
  const insertedOut = insertedDescriptors.map((d) => ({ ...d }));
  const moduleEntries = out.filter((d) => d.kind === "module" && !d.blocked);

  const pageOrigin = pageOriginFromUrl(pageUrl);
  const entryBaseUrl = opts.baseUrl || pageUrl;
  const gate = opts.gate ?? null;
  const importMap: ParsedImportMap = { imports: new Map(), scopes: new Map() };
  // One budget for the whole navigation: every parse, merge, resolution and record shares it.
  const importMapBudget = newImportMapBudget();
  const resolveModule = (specifier: string, importer: string): string | null =>
    resolveImportMapSpecifier(specifier, importer, importMap, importMapBudget);
  const integrityByUrl = new Map<string, string>();
  const nonceByUrl = new Map<string, string>();
  const viaTrustedImporter = new Set<string>();
  // A module fetch's credentials mode is its root script's crossorigin attribute, inherited by
  // imports and modulepreloads. HTML defaults all of them to "same-origin"; only an explicit
  // use-credentials asks for cookies. The first requester of a url fixes its mode, as the
  // browser's url-keyed module map does.
  const credentialsByUrl = new Map<string, "include" | "same-origin">();

  const classicSeeds = new Set<string>(opts.moduleSeeds);
  // Classic scripts share one bundle scope, so each base needs a name of its own: a hash of the
  // page-chosen base can collide and the later declaration would capture the earlier script's
  // imports. Names are allocated in walk order, so no page value selects them.
  const calleeNames = new Map<string, string>();
  const calleeNameFor = (base: string): string => {
    let name = calleeNames.get(base);
    if (name === undefined) {
      name = `__ks_import_${calleeNames.size}`;
      calleeNames.set(base, name);
    }
    return name;
  };
  const seedClassic = (
    d: ParentScriptDescriptor,
    resolve: (specifier: string, importer: string) => string | null,
  ): void => {
    if (d.kind !== "classic" || d.prefetchError || d.blocked) return;
    const isExternal = !!d.src;
    const src = isExternal ? (d.prefetchedSource ?? "") : (d.body ?? "");
    if (!src) return;
    const base = isExternal
      ? d.resolvedSrc || (d.src ? resolveAgainstImporter(d.src, entryBaseUrl) : null)
      : entryBaseUrl;
    if (!base) return;
    const { rewritten, seeds } = extractClassicDynamicSeeds(
      src,
      base,
      resolve,
      calleeNameFor(base),
    );
    if (rewritten !== src) {
      if (isExternal) d.prefetchedSource = rewritten;
      else d.body = rewritten;
    }
    for (const s of seeds) {
      classicSeeds.add(s);
      if (d.nonce && !nonceByUrl.has(s)) nonceByUrl.set(s, d.nonce);
    }
  };

  const resolvedModules: ResolvedModuleRecord[] = [];
  // The record list exists only to stop a later import map from rewriting a specifier this
  // document already resolved. Past the limit recording stops, and so do later maps: resolving
  // keeps working with the maps already merged, and an import that needs a dropped map fails
  // individually instead of the whole document losing resolution.
  let recordsExhausted = false;
  const resolveAndRecord = (specifier: string, importer: string): string | null => {
    if (!recordsExhausted) {
      if (importMapBudget.records >= MAX_RECORDED_RESOLUTIONS) {
        recordsExhausted = true;
        console.warn(
          "[kitesurf-walk] import map recorded resolution budget exceeded; " +
            "later import maps are ignored for the rest of the document",
        );
      } else {
        importMapBudget.records += 1;
        resolvedModules.push(resolvedModuleRecord(specifier, importer));
      }
    }
    return resolveModule(specifier, importer);
  };
  const moduleEntryIndex = new Map(moduleEntries.map((d, i) => [d, i] as const));
  const recordInlineModuleStatics = (d: ParentScriptDescriptor): void => {
    const body = d.body ?? "";
    const entryUrl = inlineModuleUrl(entryBaseUrl, moduleEntryIndex.get(d) ?? 0);
    let imports: ReturnType<typeof lexerParse>[0];
    try {
      imports = lexerParse(body, entryUrl)[0];
    } catch {
      return;
    }
    for (const imp of imports) {
      if (imp.t === 1 && imp.n) resolveAndRecord(imp.n, entryUrl);
    }
  };
  type DocumentItem =
    | { index: number; kind: "map"; map: ParsedImportMap }
    | { index: number; kind: "script"; script: ParentScriptDescriptor };
  const documentOrder: DocumentItem[] = [];
  for (const m of opts.importMaps ?? []) {
    const parsed = parseDocumentImportMap(m.source, m.baseUrl, importMapBudget);
    if (parsed) documentOrder.push({ index: m.scriptDomIndex, kind: "map", map: parsed });
  }
  for (const d of out) {
    documentOrder.push({ index: d.scriptDomIndex ?? -1, kind: "script", script: d });
  }
  documentOrder.sort((a, b) => a.index - b.index);
  const lateClassics: ParentScriptDescriptor[] = [];
  for (const item of documentOrder) {
    if (item.kind === "map") {
      // Without the records a map arriving now could rewrite a specifier already resolved, so it
      // is dropped like an over-limit one.
      if (!recordsExhausted) mergeImportMap(importMap, item.map, resolvedModules, importMapBudget);
      continue;
    }
    const d = item.script;
    if (d.blocked) continue;
    if (d.kind === "classic") {
      if (d.src && (d.async || d.defer)) lateClassics.push(d);
      else seedClassic(d, resolveAndRecord);
    } else if (!d.src) {
      recordInlineModuleStatics(d);
    }
  }
  for (const d of lateClassics) seedClassic(d, resolveModule);
  // Inserted scripts are not parser scripts: they resolve against the finalized map and must
  // not run at navigation.
  for (const d of insertedOut) seedClassic(d, resolveModule);

  if (moduleEntries.length === 0 && classicSeeds.size === 0) {
    return {
      descriptors: out,
      insertedDescriptors: insertedOut,
      additionalModules: {},
      importMapModuleSource: importMapModuleSource(importMap),
    };
  }

  const outbound = sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    connectionId,
    cookieKey,
  });

  const modules = new Map<string, string>();
  const responseUrlByRequest = new Map<string, string>();
  const failed = new Map<string, string>();
  interface WalkQueueItem {
    url: string;
    importer: string | null;
    isDynamic: boolean;
    depth: number;
    importerDynFanout: number;
    viaRegistry: boolean;
    preload?: true;
  }
  const queue: WalkQueueItem[] = [];
  const depthOf = new Map<string, number>();
  let totalFetches = 0;
  let bakedBytes = 0;
  let oversizedDynamicSkipped = 0;
  const sizeSkipped = new Set<string>();
  const viaDyn = new Map<string, boolean>();
  const viaReg = new Map<string, boolean>();
  const dynamicRoots = new Set<string>();
  const webpackChunkUrls = new Set<string>();
  const jsonModules = new Map<string, unknown>();
  const lexed = new Set<string>();
  const lexCache = new Map<string, ReturnType<typeof lexerParse>[0]>();

  let docTokens: Set<string> | null = null;
  const namedByDocument = (url: string): boolean => {
    const name = chunkBaseName(url);
    return name !== null && docTokens?.has(name) === true;
  };

  const crawlImports = (fromUrl: string, body: string): void => {
    const fromViaDyn = viaDyn.get(fromUrl) ?? false;
    const fromViaReg = viaReg.get(fromUrl) ?? false;
    const fromDepth = depthOf.get(fromUrl) ?? 0;
    let imports: ReturnType<typeof lexerParse>[0];
    try {
      imports = lexerParse(body, fromUrl)[0];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.set(fromUrl, `lex failed for ${fromUrl}: ${msg}`);
      modules.delete(fromUrl);
      return;
    }
    lexCache.set(fromUrl, imports);
    let dynFanout = 0;
    for (const imp of imports) {
      if (imp.t === 2) dynFanout++;
    }
    if (dynFanout > FANOUT_REGISTRY_THRESHOLD && opts.documentHtml && !docTokens) {
      docTokens = documentTokens(opts.documentHtml);
    }
    for (const imp of imports) {
      if (imp.t !== 1 && imp.t !== 2) continue;
      const isDynamic = imp.t === 2;
      const specifier = imp.n ?? (isDynamic ? constSpecifier(body.slice(imp.s, imp.e)) : undefined);
      if (!specifier) continue;
      const resolved = resolveModule(specifier, responseUrlByRequest.get(fromUrl) ?? fromUrl);
      if (!resolved) {
        if (isDynamic) continue;
        failed.set(
          fromUrl,
          `Failed to resolve module specifier "${specifier}" ` +
            `(imported from ${fromUrl}): the document's import map ` +
            `does not remap it to a URL, or blocks it.`,
        );
        modules.delete(fromUrl);
        return;
      }
      if (resolved.startsWith("data:")) continue;
      if (!isPageModuleUrl(resolved)) {
        // A dynamic import is rewritten to the runtime loader below, which refuses it.
        if (isDynamic) continue;
        failed.set(
          fromUrl,
          `Failed to load module "${specifier}" (imported from ${fromUrl}): ` +
            `${resolved} is not an http(s) module URL.`,
        );
        modules.delete(fromUrl);
        return;
      }
      if (modules.has(resolved) || failed.has(resolved)) continue;
      if (/\.wasm$/i.test(new URL(resolved).pathname)) {
        failed.set(
          resolved,
          "wasm modules in the ES-module graph are not supported " +
            "(kitesurf bakes page wasm for the WebAssembly.* APIs, " +
            "not ESM-integration)",
        );
        continue;
      }
      const childViaDyn = fromViaDyn || isDynamic;
      const prev = viaDyn.get(resolved);
      viaDyn.set(resolved, prev === undefined ? childViaDyn : prev && childViaDyn);
      const named = isDynamic && docTokens !== null && namedByDocument(resolved);
      const childViaReg =
        fromViaReg || (isDynamic && dynFanout > FANOUT_REGISTRY_THRESHOLD && !named);
      const prevReg = viaReg.get(resolved);
      viaReg.set(resolved, prevReg === undefined ? childViaReg : prevReg && childViaReg);
      viaTrustedImporter.add(resolved);
      if (!credentialsByUrl.has(resolved)) {
        credentialsByUrl.set(resolved, credentialsByUrl.get(fromUrl) ?? "same-origin");
      }
      const inheritedNonce = nonceByUrl.get(fromUrl);
      if (inheritedNonce && !nonceByUrl.has(resolved)) {
        nonceByUrl.set(resolved, inheritedNonce);
      }
      if (isDynamic) dynamicRoots.add(resolved);
      if (!depthOf.has(resolved)) depthOf.set(resolved, fromDepth + 1);
      queue.push({
        url: resolved,
        importer: fromUrl,
        isDynamic,
        depth: fromDepth + 1,
        importerDynFanout: isDynamic && !named ? dynFanout : 0,
        viaRegistry: childViaReg,
      });
    }
  };

  for (const seedUrl of classicSeeds) {
    if (!modules.has(seedUrl) && !failed.has(seedUrl)) {
      viaDyn.set(seedUrl, false);
      depthOf.set(seedUrl, 0);
      queue.push({
        url: seedUrl,
        importer: null,
        isDynamic: false,
        depth: 0,
        importerDynFanout: 0,
        viaRegistry: false,
      });
    }
  }

  for (const [i, d] of moduleEntries.entries()) {
    let entryUrl: string;
    if (d.src) {
      const resolved = d.resolvedSrc ?? resolveAgainstImporter(d.src, entryBaseUrl);
      if (!resolved) {
        d.prefetchError = "could not resolve module src against page URL: " + d.src;
        continue;
      }
      entryUrl = resolved;
      d.resolvedSrc = entryUrl;
      if (!credentialsByUrl.has(entryUrl)) {
        credentialsByUrl.set(entryUrl, scriptCredentialsMode(d.crossOrigin));
      }
      if (d.integrity) integrityByUrl.set(entryUrl, d.integrity);
      if (d.nonce) nonceByUrl.set(entryUrl, d.nonce);
      if (!modules.has(entryUrl) && !failed.has(entryUrl)) {
        viaDyn.set(entryUrl, false);
        depthOf.set(entryUrl, 0);
        queue.push({
          url: entryUrl,
          importer: null,
          isDynamic: false,
          depth: 0,
          importerDynFanout: 0,
          viaRegistry: false,
        });
      }
    } else {
      entryUrl = inlineModuleUrl(entryBaseUrl, i);
      d.resolvedSrc = entryUrl;
      if (d.nonce) nonceByUrl.set(entryUrl, d.nonce);
      viaDyn.set(entryUrl, false);
      depthOf.set(entryUrl, 0);
      const rawBody = d.body ?? "";
      const body = maybeWrapInlineModule(rawBody, entryUrl);
      modules.set(entryUrl, body);
      bakedBytes += body.length;
      d.prefetchedSource = body;
      lexed.add(entryUrl);
      crawlImports(entryUrl, body);
    }
  }

  for (const { url, nonce, integrity, crossOrigin } of opts.preloadSeeds ?? []) {
    // The pin binds every fetch of the url, including one an entry's import already queued.
    if (integrity && !integrityByUrl.has(url)) integrityByUrl.set(url, integrity);
    if (modules.has(url) || failed.has(url) || depthOf.has(url)) continue;
    if (nonce && !nonceByUrl.has(url)) nonceByUrl.set(url, nonce);
    if (!credentialsByUrl.has(url)) credentialsByUrl.set(url, scriptCredentialsMode(crossOrigin));
    viaDyn.set(url, false);
    depthOf.set(url, 0);
    queue.push({
      url,
      importer: null,
      isDynamic: false,
      depth: 0,
      importerDynFanout: 0,
      viaRegistry: false,
      preload: true,
    });
  }

  const MODULE_FETCH_ATTEMPTS = 3;
  type ModuleFetchResult =
    | { ok: true; body: string; moduleType: ModuleType; responseUrl: string }
    | { ok: false; error: string };

  const isTransientFetchError = (error: string): boolean =>
    /aborted|abort|connection|network connection lost|reset|HTTP 5\d\d|timed out|timeout/i.test(
      error,
    );

  const attemptFetchModuleBody = async (url: string): Promise<ModuleFetchResult> => {
    let fetchUrl = url;
    if (gate) {
      const pre = await checkScriptBeforeFetch(gate, {
        url,
        integrity: integrityByUrl.get(url) ?? null,
        nonce: nonceByUrl.get(url) ?? null,
        runtimeInserted: viaTrustedImporter.has(url),
        module: true,
      });
      if (pre.reportOnly) console.warn(`[kitesurf-csp] ${pre.reportOnly}`);
      if (!pre.allowed) {
        return { ok: false, error: pre.message ?? `module blocked: ${url}` };
      }
      fetchUrl = pre.upgradeTo ?? url;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "x-kitesurf-resource-type": "Script",
        "x-kitesurf-script-cors": "cors",
        "x-kitesurf-credentials": credentialsByUrl.get(url) ?? "same-origin",
        "x-kitesurf-initiator": "module-graph",
        "x-kitesurf-page-origin": pageOrigin,
      };
      if (connectionId) headers["x-kitesurf-connection-id"] = connectionId;
      if (mainFrameId) headers["x-kitesurf-frame-id"] = mainFrameId;
      if (pageOrigin) headers["origin"] = pageOrigin;
      const walk = await walkRedirects({
        url: fetchUrl,
        signal: ctrl.signal,
        headers,
        taintOriginFrom: pageOrigin || undefined,
        fetchHop: (hopReq) => outbound.fetch(hopReq),
        checkRedirect: gate
          ? async (hopUrl) => {
              const hop = checkScriptRedirect(
                gate,
                {
                  url,
                  nonce: nonceByUrl.get(url) ?? null,
                  runtimeInserted: viaTrustedImporter.has(url),
                },
                hopUrl,
              );
              return hop.allowed ? (hop.upgradeTo ?? hopUrl) : null;
            }
          : undefined,
      });
      if (!walk.ok && walk.reason === "redirect-blocked") {
        return { ok: false, error: `module blocked: redirect to ${walk.url}` };
      }
      if (!walk.ok) {
        return { ok: false, error: `module fetch too many redirects for ${url}` };
      }
      const res = walk.response;
      const blocked = res.headers.get("x-kitesurf-blocked");
      if (res.status === 403 && blocked) {
        await res.body?.cancel().catch(() => {});
        return {
          ok: false,
          error: `module fetch blocked (${blocked}) for ${url}`,
        };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return {
          ok: false,
          error: `module fetch returned HTTP ${res.status} for ${url}`,
        };
      }
      const integrity = integrityByUrl.get(url) ?? null;
      // Capped per body but not charged to the shared read budget, as for classic scripts
      // in prefetch-scripts.ts.
      const capped = await readCapped(res.body, MAX_DOCUMENT_BYTES);
      if (capped.bytes === null) {
        await capped.rest.cancel().catch(() => {});
        return {
          ok: false,
          error: `module body ${capped.failure} for ${url}`,
        };
      }
      const bytes = integrity ? capped.bytes : null;
      const body = new TextDecoder("utf-8", {
        fatal: false,
        ignoreBOM: false,
      }).decode(capped.bytes);
      const verdict = await checkScriptResponse(
        { url, integrity, module: true },
        {
          contentType: res.headers.get("content-type"),
          contentTypeOptions: res.headers.get(KITESURF_NOSNIFF_HEADER),
          bytes,
          opaque: false,
        },
      );
      if (!verdict.allowed) {
        return {
          ok: false,
          error: verdict.message ?? `module blocked by policy: ${url}`,
        };
      }
      return {
        ok: true,
        body,
        moduleType: verdict.moduleType ?? "javascript",
        responseUrl: walk.finalUrl,
      };
    } catch (err) {
      return {
        ok: false,
        error:
          `module fetch threw for ${url}: ` + (err instanceof Error ? err.message : String(err)),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchModuleBody = async (url: string): Promise<ModuleFetchResult> => {
    let last: ModuleFetchResult = {
      ok: false,
      error: `module fetch not attempted for ${url}`,
    };
    for (let attempt = 1; attempt <= MODULE_FETCH_ATTEMPTS; attempt++) {
      last = await attemptFetchModuleBody(url);
      if (last.ok || !isTransientFetchError(last.error)) return last;
      if (attempt < MODULE_FETCH_ATTEMPTS) {
        const base = MODULE_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        const delay = base + Math.random() * base * MODULE_FETCH_RETRY_JITTER_RATIO;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return last;
  };

  const storeFetched = (
    url: string,
    fetched: { body: string; moduleType: ModuleType; responseUrl: string },
  ): boolean => {
    responseUrlByRequest.set(url, fetched.responseUrl);
    if (fetched.moduleType === "json") {
      try {
        jsonModules.set(url, JSON.parse(fetched.body));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.set(url, `JSON module ${url} did not parse: ${msg}`);
        return false;
      }
      modules.set(url, fetched.body);
      bakedBytes += fetched.body.length;
      lexed.add(url);
      return true;
    }
    modules.set(url, fetched.body);
    bakedBytes += fetched.body.length;
    if (!lexed.has(url)) {
      lexed.add(url);
      crawlImports(url, fetched.body);
    }
    return true;
  };

  const walkStartedAt = Date.now();
  let deadlineHit = false;
  const pastDeadline = (): boolean => {
    if (!deadlineHit && Date.now() - walkStartedAt >= WALK_DEADLINE_MS) {
      deadlineHit = true;
    }
    return deadlineHit;
  };
  let deadlineSkipped = 0;

  let inflight = 0;
  const inflightUrls = new Set<string>();
  let waiters: Array<() => void> = [];
  const notifyAll = (): void => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };

  const itemClass = (item: WalkQueueItem): number =>
    !item.isDynamic ? 0 : item.importerDynFanout > FANOUT_REGISTRY_THRESHOLD ? 2 : 1;

  const nextItem = (): (WalkQueueItem & { sizeCapped: boolean }) | "wait" | "done" => {
    const keep: WalkQueueItem[] = [];
    let best: WalkQueueItem | null = null;
    let bestClass = 3;
    for (const item of queue) {
      if (modules.size >= MAX_MODULES) {
        queue.length = 0;
        return inflight > 0 ? "wait" : "done";
      }
      const url = item.url;
      if (failed.has(url)) continue;
      if (inflightUrls.has(url)) {
        keep.push(item);
        continue;
      }
      if (modules.has(url)) {
        if (!lexed.has(url)) {
          lexed.add(url);
          crawlImports(url, modules.get(url)!);
        }
        continue;
      }
      if (item.isDynamic && bakedBytes >= BAKE_BUDGET_BYTES) continue;
      if (item.viaRegistry && pastDeadline()) {
        deadlineSkipped++;
        continue;
      }
      if (isAssetExtension(url)) {
        // Not the url: a "*/" in its query would end the comment.
        modules.set(url, "/* kitesurf: asset-import side-effect stub */\nexport {};\n");
        continue;
      }
      keep.push(item);
      const cls = itemClass(item);
      if (best === null || cls < bestClass || (cls === bestClass && item.depth < best.depth)) {
        best = item;
        bestClass = cls;
      }
    }
    queue.length = 0;
    for (const item of keep) {
      if (item !== best) queue.push(item);
    }
    if (best) {
      return {
        ...best,
        sizeCapped: best.isDynamic || (best.importer === null && classicSeeds.has(best.url)),
      };
    }
    return inflight > 0 ? "wait" : "done";
  };

  const workerLoop = async (): Promise<void> => {
    for (;;) {
      const item = nextItem();
      if (item === "done") {
        notifyAll();
        return;
      }
      if (item === "wait") {
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      inflight++;
      inflightUrls.add(item.url);
      let result: ModuleFetchResult;
      try {
        result = await fetchModuleBody(item.url);
      } finally {
        inflightUrls.delete(item.url);
        inflight--;
        notifyAll();
      }
      totalFetches++;
      if (!result.ok) {
        if (!item.preload) failed.set(item.url, result.error);
      } else if (item.sizeCapped && result.body.length > MAX_DYNAMIC_MODULE_BYTES) {
        oversizedDynamicSkipped++;
        sizeSkipped.add(item.url);
      } else if (!(item.isDynamic && bakedBytes >= BAKE_BUDGET_BYTES)) {
        storeFetched(item.url, result);
      }
    }
  };
  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, () => workerLoop()));

  {
    const MAX_WEBPACK_CHUNKS = 300;
    const MAX_WEBPACK_COMPOSER_SCAN_CHARS = 120_000;
    let composeBase: string | null = null;
    let nameMap: Record<string, string> | null = null;
    let hashMap: Record<string, string> | null = null;
    for (const [url, body] of modules) {
      const uIdx = body.search(/\.u\s*=/);
      if (uIdx < 0) continue;
      const win = body.slice(uIdx, uIdx + MAX_WEBPACK_COMPOSER_SCAN_CHARS);
      const end = win.indexOf('".js"');
      if (end < 0) continue;
      const expr = win.slice(0, end + 5);
      const maps: Record<string, string>[] = [];
      for (const m of expr.matchAll(/\{(?:\d+:"[^"]*",?)+\}/g)) {
        const obj: Record<string, string> = {};
        for (const kv of m[0].slice(1, -1).split(",")) {
          const ci = kv.indexOf(':"');
          if (ci < 0) continue;
          obj[kv.slice(0, ci)] = kv.slice(ci + 2, -1);
        }
        maps.push(obj);
      }
      if (maps.length === 0) continue;
      nameMap = maps.length >= 2 ? maps[0]! : null;
      hashMap = maps[maps.length - 1]!;
      composeBase = url;
      break;
    }
    const webpackBase = composeBase;
    const webpackHashMap = hashMap;
    if (webpackBase && webpackHashMap) {
      const seenIds = new Set<string>();
      const pendingIds: string[] = [];
      const pushId = (id: string) => {
        if (!seenIds.has(id) && webpackHashMap[id] !== undefined) {
          seenIds.add(id);
          pendingIds.push(id);
        }
      };
      const scanForIds = (body: string) => {
        for (const m of body.matchAll(/\.e\((\d+)\)/g)) pushId(m[1]!);
        for (const m of body.matchAll(/\[(\d{1,6}(?:,\d{1,6})+)\]/g)) {
          const ids = m[1]!.split(",");
          if (ids.every((id) => webpackHashMap[id] !== undefined)) {
            for (const id of ids) pushId(id);
          }
        }
      };
      for (const body of modules.values()) scanForIds(body);
      const drainWebpackQueue = async (): Promise<void> => {
        while (queue.length > 0) {
          const wave2: typeof queue = [];
          while (queue.length > 0 && wave2.length < WALK_CONCURRENCY) {
            const item = queue.shift()!;
            if (
              modules.has(item.url) ||
              failed.has(item.url) ||
              (item.isDynamic && (bakedBytes >= BAKE_BUDGET_BYTES || pastDeadline()))
            ) {
              continue;
            }
            wave2.push(item);
          }
          if (wave2.length === 0) continue;
          const drained = await Promise.all(
            wave2.map(async (item) => {
              const r = await fetchModuleBody(item.url);
              totalFetches++;
              return { item, r };
            }),
          );
          for (const { item, r } of drained) {
            if (!r.ok) {
              failed.set(item.url, r.error);
              continue;
            }
            if (!storeFetched(item.url, r)) continue;
            if (r.moduleType === "javascript") scanForIds(r.body);
          }
        }
      };
      let bakedChunks = 0;
      while (pendingIds.length > 0 && bakedChunks < MAX_WEBPACK_CHUNKS && !pastDeadline()) {
        if (bakedBytes >= BAKE_BUDGET_BYTES) break;
        const wave = pendingIds
          .splice(0, WALK_CONCURRENCY)
          .map((id) => {
            const hash = webpackHashMap[id];
            if (hash === undefined) return null;
            const name = nameMap?.[id] ?? id;
            const resolved = resolveAgainstImporter(
              `./${name}.${hash}.js`,
              responseUrlByRequest.get(webpackBase) ?? webpackBase,
            );
            return resolved && !modules.has(resolved) && !failed.has(resolved)
              ? { id, url: resolved }
              : null;
          })
          .filter((x): x is { id: string; url: string } => x !== null);
        if (wave.length === 0) continue;
        const results = await Promise.all(
          wave.map(async ({ url }) => {
            const r = await fetchModuleBody(url);
            totalFetches++;
            return { url, result: r };
          }),
        );
        for (const { url, result } of results) {
          if (!result.ok) {
            failed.set(url, result.error);
            continue;
          }
          if (bakedBytes >= BAKE_BUDGET_BYTES) break;
          if (!storeFetched(url, result)) continue;
          viaDyn.set(url, true);
          dynamicRoots.add(url);
          webpackChunkUrls.add(url);
          bakedChunks++;
          if (result.moduleType === "javascript") scanForIds(result.body);
        }
        await drainWebpackQueue();
      }
      if (bakedChunks > 0) {
        console.log(
          `[kitesurf-walk] webpack chunk crawl: ${bakedChunks} chunk(s) baked from ${composeBase}`,
        );
      }
    }
  }

  let evictedCount = 0;
  let prunedCount = 0;
  if (deadlineHit) {
    const resolveStatic = resolveModule;
    let completeness = new Map<string, boolean>();
    const staticDepsComplete = (url: string): boolean => {
      const memo = completeness.get(url);
      if (memo !== undefined) return memo;
      completeness.set(url, true);
      for (const imp of lexCache.get(url) ?? []) {
        if (imp.t !== 1 || !imp.n) continue;
        const resolved = resolveStatic(imp.n, responseUrlByRequest.get(url) ?? url);
        if (!resolved) continue;
        if (!modules.has(resolved) || !staticDepsComplete(resolved)) {
          completeness.set(url, false);
          return false;
        }
      }
      return true;
    };
    for (let changed = true; changed;) {
      changed = false;
      completeness = new Map();
      for (const root of dynamicRoots) {
        if (!modules.has(root) || viaDyn.get(root) === false) continue;
        if (!staticDepsComplete(root)) {
          modules.delete(root);
          evictedCount++;
          changed = true;
        }
      }
    }
    const reachable = new Set<string>();
    const stack: string[] = [];
    const pushRoot = (u: string | null | undefined): void => {
      if (u && modules.has(u) && !reachable.has(u)) {
        reachable.add(u);
        stack.push(u);
      }
    };
    for (const d of moduleEntries) pushRoot(d.resolvedSrc);
    for (const s of classicSeeds) pushRoot(s);
    for (const c of webpackChunkUrls) pushRoot(c);
    while (stack.length > 0) {
      const url = stack.pop()!;
      for (const imp of lexCache.get(url) ?? []) {
        if (imp.t !== 1 && imp.t !== 2) continue;
        const spec =
          imp.n ??
          (imp.t === 2 ? constSpecifier(modules.get(url)!.slice(imp.s, imp.e)) : undefined);
        if (!spec) continue;
        const resolved = resolveStatic(spec, responseUrlByRequest.get(url) ?? url);
        if (resolved) pushRoot(resolved);
      }
    }
    for (const u of [...modules.keys()]) {
      if (!reachable.has(u) && viaDyn.get(u) === true) {
        modules.delete(u);
        prunedCount++;
      }
    }
  }

  // A missing static dependency makes every importing module fail, even if a registry alias
  // could otherwise satisfy its native import under a different URL.
  const staticImporters = new Map<string, Set<string>>();
  const missingStatic = new Map<string, string>();
  for (const [fromUrl] of modules) {
    for (const imp of lexCache.get(fromUrl) ?? []) {
      if (imp.t !== 1 || !imp.n) continue;
      const resolved = resolveModule(imp.n, responseUrlByRequest.get(fromUrl) ?? fromUrl);
      if (!resolved || !isPageModuleUrl(resolved)) continue;
      const importers = staticImporters.get(resolved) ?? new Set<string>();
      importers.add(fromUrl);
      staticImporters.set(resolved, importers);
      if (!modules.has(resolved) && !missingStatic.has(fromUrl)) {
        missingStatic.set(fromUrl, resolved);
      }
    }
  }
  const incomplete = [...missingStatic.keys()];
  for (const fromUrl of incomplete) {
    const dependency = missingStatic.get(fromUrl);
    if (!dependency) continue;
    modules.delete(fromUrl);
    failed.set(fromUrl, `Failed to load static module ${dependency} imported from ${fromUrl}`);
    for (const importer of staticImporters.get(fromUrl) ?? []) {
      if (missingStatic.has(importer)) continue;
      missingStatic.set(importer, fromUrl);
      incomplete.push(importer);
    }
  }

  const registryNames = assignModuleRegistryNames(modules.keys());
  const registryName = (url: string): string => registryNames.get(url) ?? url;

  for (const u of [...sizeSkipped]) if (modules.has(u)) sizeSkipped.delete(u);

  if (registryNames.size > 0 || sizeSkipped.size > 0) {
    for (const d of [...out, ...insertedOut]) {
      if (d.kind === "module") continue;
      const field = d.src ? "prefetchedSource" : "body";
      const source = d[field];
      if (!source || !/import\s*\(/.test(source)) continue;
      const base = d.src
        ? d.resolvedSrc || resolveAgainstImporter(d.src, entryBaseUrl)
        : entryBaseUrl;
      if (!base) continue;
      let parsed: ReturnType<typeof lexerParse>[0];
      try {
        parsed = lexerParse(source)[0];
      } catch {
        continue;
      }
      const rewrites: { ss: number; se: number; text: string }[] = [];
      for (const imp of parsed) {
        if (imp.t !== 2) continue;
        const spec = imp.n ?? constSpecifier(source.slice(imp.s, imp.e));
        if (!spec) continue;
        let absolute: string;
        try {
          absolute = new URL(spec, base).href;
        } catch {
          continue;
        }
        if (sizeSkipped.has(absolute)) {
          rewrites.push({
            ss: imp.ss,
            se: imp.se,
            text: runtimeImportCall(source, imp, JSON.stringify(base), absolute),
          });
          continue;
        }
        const name = registryNames.get(absolute);
        if (name) rewrites.push({ ss: imp.s, se: imp.e, text: JSON.stringify(name) });
      }
      let rewritten = source;
      for (const rw of rewrites.sort((a, b) => b.ss - a.ss)) {
        rewritten = rewritten.slice(0, rw.ss) + rw.text + rewritten.slice(rw.se);
      }
      d[field] = rewritten;
    }
  }

  let deferredCount = 0;
  const literalRange = (imp: LexedImport): { ss: number; se: number } =>
    imp.t === 1 ? { ss: imp.s - 1, se: imp.e + 1 } : { ss: imp.s, se: imp.e };
  for (const [fromUrl, body] of [...modules.entries()]) {
    if (jsonModules.has(fromUrl)) continue;
    let imports: ReturnType<typeof lexerParse>[0] | undefined = lexCache.get(fromUrl);
    if (!imports) {
      try {
        imports = lexerParse(body, fromUrl)[0];
      } catch {
        continue;
      }
    }
    const responseUrl = responseUrlByRequest.get(fromUrl) ?? fromUrl;
    const ref = JSON.stringify(responseUrl);
    let syntheticImportMeta: string | undefined;
    if (registryName(fromUrl) !== responseUrl) {
      syntheticImportMeta = "__ks_import_meta";
      while (body.includes(syntheticImportMeta)) syntheticImportMeta += "_";
    }
    const rewrites: { ss: number; se: number; text: string }[] = [];
    const dynamicRanges = imports
      .filter((imp) => imp.t === 2)
      .map((imp) => ({ start: imp.ss, end: imp.se }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < dynamicRanges.length; i++) {
      const previous = dynamicRanges[i - 1];
      const current = dynamicRanges[i];
      if (previous && current) current.end = Math.max(current.end, previous.end);
    }
    const isInDynamicImport = (start: number, end: number): boolean => {
      let lo = 0;
      let hi = dynamicRanges.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const range = dynamicRanges[mid];
        if (range && range.start <= start) lo = mid + 1;
        else hi = mid;
      }
      const range = dynamicRanges[lo - 1];
      return range !== undefined && range.end >= end;
    };
    for (const imp of imports) {
      if (imp.t === 2) {
        const spec = imp.n ?? constSpecifier(body.slice(imp.s, imp.e));
        if (!spec && imp.d > -1) {
          const args = rewriteImportMetaResolve(
            dynamicImportArguments(body, imp),
            responseUrl,
            syntheticImportMeta,
          );
          const call =
            imp.a < 0
              ? `__ks_import(${args}, ${ref})`
              : `((s, o) => __ks_import(s, ${ref}, o))(${args})`;
          rewrites.push({ ss: imp.ss, se: imp.se, text: call });
        }
        if (!spec) continue;

        const resolved = resolveModule(spec, responseUrl);
        const registryResolved = resolved && modules.has(resolved) ? registryName(resolved) : null;
        if (
          registryResolved !== null &&
          !nativelyResolvesTo(spec, registryName(fromUrl), registryResolved)
        ) {
          rewrites.push({ ...literalRange(imp), text: JSON.stringify(registryResolved) });
        }
        if (registryResolved !== null) continue;

        rewrites.push({
          ss: imp.ss,
          se: imp.se,
          text: runtimeImportCall(body, imp, ref),
        });
        deferredCount++;
        continue;
      }

      if (imp.t === 3) {
        if (isInDynamicImport(imp.ss, imp.se)) {
          continue;
        }
        if (syntheticImportMeta) {
          rewrites.push({ ss: imp.ss, se: imp.se, text: syntheticImportMeta });
          continue;
        }
        const resolveEnd = importMetaResolveEnd(body, imp);
        if (resolveEnd === null) continue;
        rewrites.push({
          ss: imp.ss,
          se: resolveEnd,
          text: `((specifier) => globalThis.__ks_resolve_import_map(specifier, ${ref}))`,
        });
        continue;
      }

      if (imp.t !== 1 || !imp.n) continue;
      const resolved = resolveModule(imp.n, responseUrl);
      if (!resolved) continue;
      const registryResolved = registryName(resolved);
      if (!nativelyResolvesTo(imp.n, registryName(fromUrl), registryResolved)) {
        rewrites.push({ ...literalRange(imp), text: JSON.stringify(registryResolved) });
      }
    }
    if (rewrites.length > 0 || syntheticImportMeta) {
      let b = body;
      for (const rw of rewrites.sort((a, c) => c.ss - a.ss)) {
        b = b.slice(0, rw.ss) + rw.text + b.slice(rw.se);
      }
      if (syntheticImportMeta) {
        b =
          `const ${syntheticImportMeta}=Object.assign(Object.create(null),` +
          `{url:${ref},resolve:(specifier)=>globalThis.__ks_resolve_import_map(specifier,${ref})});\n` +
          b;
      }
      modules.set(fromUrl, b);
    }
  }

  for (const d of moduleEntries) {
    if (d.prefetchError) continue;
    const u = d.resolvedSrc;
    if (!u) continue;
    const failure = failed.get(u);
    if (failure !== undefined) {
      d.prefetchError = failure;
      continue;
    }
    const body = modules.get(u);
    if (body == null) {
      d.prefetchError = `module not in graph after walk: ${u}`;
      continue;
    }
    d.prefetchedSource = body;
    d.resolvedSrc = registryName(u);
  }

  if (totalFetches > 0 || moduleEntries.length > 0) {
    const parts = [
      `${moduleEntries.length} module entr${moduleEntries.length === 1 ? "y" : "ies"}`,
      `${modules.size} modules baked`,
      `${totalFetches} fetches`,
    ];
    if (failed.size > 0) parts.push(`${failed.size} failed`);
    if (deferredCount > 0) parts.push(`${deferredCount} dyn deferred->boa`);
    if (oversizedDynamicSkipped > 0) {
      parts.push(`${oversizedDynamicSkipped} oversized dyn skipped`);
    }
    parts.push(`${(bakedBytes / BYTES_PER_MIB).toFixed(1)}MiB baked`);
    if (modules.size >= MAX_MODULES) {
      parts.push(`hit MAX_MODULES=${MAX_MODULES} cap`);
    }
    if (deadlineHit) {
      parts.push(
        `hit ${WALK_DEADLINE_MS}ms deadline ` +
          `(${deadlineSkipped} skipped, ${evictedCount} evicted, ${prunedCount} pruned)`,
      );
    }
    parts.push(`${Date.now() - walkStartedAt}ms`);
    console.log(`[kitesurf-walk] ${parts.join(", ")}`);
  }

  const additionalModules: Record<string, BakedModule> = {};
  for (const [u, body] of modules) {
    additionalModules[registryName(u)] = jsonModules.has(u) ? { json: jsonModules.get(u) } : body;
  }

  return {
    descriptors: out,
    insertedDescriptors: insertedOut,
    additionalModules,
    importMapModuleSource: importMapModuleSource(importMap, registryNames),
  };
}
