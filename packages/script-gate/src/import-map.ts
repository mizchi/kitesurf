// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parses and gates document import maps and emits their page-module resolver.

import { checkScriptBeforeFetch, scriptGateIsNoop, type ScriptGateContext } from "./gate.ts";

export interface ScannedImportMap {
  body: string;
  scriptDomIndex: number;
  baseHref: string | null;
  nonce: string | null;
}

export interface DocumentScriptMetadata {
  metaCsp: string[];
  importMaps: ScannedImportMap[];
}

export interface ImportMapResolver {
  resolveImportMap(specifier: unknown, importer: string): string;
  resolveModuleRegistryUrl(url: unknown): string;
}

export interface ParsedImportMap {
  imports: Map<string, string | null>;
  scopes: Map<string, Map<string, string | null>>;
}

type ImportMapScope = readonly [string, Map<string, string | null>];
const sortedScopesByMap = new WeakMap<ParsedImportMap, readonly ImportMapScope[]>();
// Only "/"-terminated keys can match a prefix, and a map is mostly exact keys: scanning just the
// prefix rules is the difference between a lookup costing 2,000 comparisons and a handful.
const prefixKeysByMap = new WeakMap<ReadonlyMap<string, string | null>, readonly string[]>();

function prefixKeys(mappings: ReadonlyMap<string, string | null>): readonly string[] {
  const cached = prefixKeysByMap.get(mappings);
  if (cached) return cached;
  const keys = [...mappings.keys()].filter((key) => key.endsWith("/"));
  prefixKeysByMap.set(mappings, keys);
  return keys;
}

const SPECIAL_SCHEMES = new Set(["ftp:", "file:", "http:", "https:", "ws:", "wss:"]);

function parseUrlLikeSpecifier(specifier: string, baseUrl: string): URL | null {
  const baseRelative =
    specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../");
  // Without a ":" a non-relative specifier cannot parse as an absolute URL (the parser drops
  // whitespace around a scheme, so no stricter shape test is safe), and a throwing `new URL`
  // costs ~2 us on the resolution hot path.
  if (!baseRelative && !specifier.includes(":")) return null;
  try {
    return baseRelative ? new URL(specifier, baseUrl) : new URL(specifier);
  } catch {
    return null;
  }
}

// Limits cover every map merged into one document and are calibrated so the largest measured
// legitimate shapes stay under a quarter of them (see the batch notes). An over-limit map is
// ignored like an invalid one; dropping it cannot unblock anything the script gate refused.
export const MAX_IMPORT_MAP_ENTRIES = 16_384;
export const MAX_IMPORT_MAP_SCOPES = 256;
export const MAX_IMPORT_MAP_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_MAP_KEY_CODE_UNITS = 2_048;
export const MAX_RECORDED_RESOLUTIONS = 8_192;
export const MAX_IMPORT_MAP_WORK = 400_000_000;

export class ImportMapBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportMapBudgetError";
  }
}

export interface ImportMapBudget {
  entries: number;
  scopes: number;
  records: number;
  work: number;
  /** A running limit is spent: the map is no longer consulted and the walk continues. */
  degraded: boolean;
}

export function newImportMapBudget(): ImportMapBudget {
  return { entries: 0, scopes: 0, records: 0, work: 0, degraded: false };
}

/**
 * Over a running limit the map degrades instead of failing the navigation: no later resolution
 * consults it, so each import that needs it fails closed while the document still loads.
 */
function degradeImportMap(budget: ImportMapBudget, limit: string): void {
  if (budget.degraded) return;
  budget.degraded = true;
  console.warn(
    `[kitesurf-walk] import map ${limit} budget exceeded; ` +
      "imports that need the map fail closed for the rest of the document",
  );
}

/** One work unit is roughly one nanosecond at the slowest charged site (measured). */
function chargeImportMapWork(budget: ImportMapBudget, units: number): void {
  budget.work += units;
  if (budget.work > MAX_IMPORT_MAP_WORK) degradeImportMap(budget, "work");
}

/** A rule/record comparison: ~6 ns of call overhead plus ~0.6 ns per compared code unit. */
function chargeRuleComparison(
  budget: ImportMapBudget,
  keyLength: number,
  otherLength: number,
): void {
  chargeImportMapWork(budget, 1 + Math.min(keyLength, otherLength));
}

/** A scope comparison costs ~48 ns: three string operations per scope, measured. */
function chargeScopeComparison(
  budget: ImportMapBudget,
  scopeLength: number,
  referrerLength: number,
): void {
  chargeImportMapWork(budget, 32 + Math.min(scopeLength, referrerLength));
}

/** One resolution: URL parse, normalization and exact-map hash lookup, ~60-120 ns. */
function chargeResolution(budget: ImportMapBudget, normalizedLength: number): void {
  chargeImportMapWork(budget, 128 + normalizedLength);
}

function checkImportMapKey(key: string): void {
  if (key.length > MAX_IMPORT_MAP_KEY_CODE_UNITS) {
    throw new ImportMapBudgetError("import map key exceeds the key length limit");
  }
}

/** Counts UTF-8 bytes by code point without encoding a copy of the source. */
function importMapSourceOverLimit(source: string): boolean {
  let bytes = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > MAX_IMPORT_MAP_SOURCE_BYTES) return true;
  }
  return false;
}

function parseSpecifierMap(
  value: unknown,
  baseUrl: string,
  budget: ImportMapBudget,
): Map<string, string | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = new Map<string, string | null>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (rawKey === "") continue;
    checkImportMapKey(rawKey);
    budget.entries += 1;
    if (budget.entries > MAX_IMPORT_MAP_ENTRIES) {
      throw new ImportMapBudgetError("import map exceeds the entry limit");
    }

    const key = parseUrlLikeSpecifier(rawKey, baseUrl)?.href ?? rawKey;
    const address =
      typeof rawValue === "string"
        ? (parseUrlLikeSpecifier(rawValue, baseUrl)?.href ?? null)
        : null;
    out.set(key, address !== null && key.endsWith("/") && !address.endsWith("/") ? null : address);
  }
  return out;
}

export function parseImportMap(
  source: string,
  baseUrl: string,
  budget: ImportMapBudget = newImportMapBudget(),
): ParsedImportMap | null {
  if (importMapSourceOverLimit(source)) {
    throw new ImportMapBudgetError("import map source exceeds the byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const imports =
    record["imports"] === undefined
      ? new Map()
      : parseSpecifierMap(record["imports"], baseUrl, budget);
  if (imports === null) return null;
  const scopes = new Map<string, Map<string, string | null>>();
  if (record["scopes"] !== undefined) {
    if (
      !record["scopes"] ||
      typeof record["scopes"] !== "object" ||
      Array.isArray(record["scopes"])
    ) {
      return null;
    }
    for (const [rawScope, mappings] of Object.entries(record["scopes"])) {
      checkImportMapKey(rawScope);
      budget.scopes += 1;
      if (budget.scopes > MAX_IMPORT_MAP_SCOPES) {
        throw new ImportMapBudgetError("import map exceeds the scope limit");
      }
      const specifierMap = parseSpecifierMap(mappings, baseUrl, budget);

      if (specifierMap === null) return null;
      let scope: string;
      try {
        scope = new URL(rawScope, baseUrl).href;
      } catch {
        continue;
      }
      scopes.set(scope, specifierMap);
    }
  }
  return { imports, scopes };
}

export interface ResolvedModuleRecord {
  referrer: string;
  specifier: string;
  prefixMatchable: boolean;
}

export function resolvedModuleRecord(specifier: string, referrer: string): ResolvedModuleRecord {
  const asUrl = parseUrlLikeSpecifier(specifier, referrer);
  return {
    referrer,
    specifier: asUrl?.href ?? specifier,
    prefixMatchable: asUrl === null || SPECIAL_SCHEMES.has(asUrl.protocol),
  };
}

function scopeMatches(scopePrefix: string, referrer: string): boolean {
  return (
    scopePrefix === referrer || (scopePrefix.endsWith("/") && referrer.startsWith(scopePrefix))
  );
}

function scopesBySpecificity(importMap: ParsedImportMap): readonly ImportMapScope[] {
  const cached = sortedScopesByMap.get(importMap);
  if (cached) return cached;
  const sorted = [...importMap.scopes.entries()].sort(([a], [b]) => b.length - a.length);
  sortedScopesByMap.set(importMap, sorted);
  return sorted;
}

function ruleMatchesRecord(key: string, record: ResolvedModuleRecord): boolean {
  return (
    key === record.specifier ||
    (record.prefixMatchable && key.endsWith("/") && record.specifier.startsWith(key))
  );
}

export function mergeImportMap(
  target: ParsedImportMap,
  incoming: ParsedImportMap,
  resolved: readonly ResolvedModuleRecord[] = [],
  budget: ImportMapBudget = newImportMapBudget(),
): void {
  sortedScopesByMap.delete(target);
  // A degraded map still merges so both resolvers keep the same rules; only the "already
  // resolved" filtering stops, because recording stopped and re-walking records would re-spend
  // the work budget.
  for (const [scopePrefix, mappings] of incoming.scopes) {
    const kept = new Map(mappings);
    // Scan the live map: copying its keys per record allocated the whole list once per record,
    // and deleting the entry being visited is defined for Map iterators.
    scan: for (const record of budget.degraded ? [] : resolved) {
      chargeScopeComparison(budget, scopePrefix.length, record.referrer.length);
      if (budget.degraded) break;
      if (!scopeMatches(scopePrefix, record.referrer)) continue;
      for (const key of kept.keys()) {
        chargeRuleComparison(budget, key.length, record.specifier.length);
        if (ruleMatchesRecord(key, record)) kept.delete(key);
        // Comparisons left after the budget is spent cannot change the outcome.
        if (budget.degraded) break scan;
      }
    }
    const existing = target.scopes.get(scopePrefix);
    if (!existing) {
      target.scopes.set(scopePrefix, kept);
      continue;
    }
    for (const [key, address] of kept) {
      if (!existing.has(key)) {
        existing.set(key, address);
        prefixKeysByMap.delete(existing);
      }
    }
  }
  for (const [key, address] of incoming.imports) {
    let claimed = false;
    for (const record of budget.degraded ? [] : resolved) {
      chargeRuleComparison(budget, key.length, record.specifier.length);
      if (ruleMatchesRecord(key, record)) {
        claimed = true;
        break;
      }
    }
    if (claimed) continue;
    if (!target.imports.has(key)) {
      target.imports.set(key, address);
      prefixKeysByMap.delete(target.imports);
    }
  }
}

export function parseDocumentImportMap(
  source: string,
  baseUrl: string,
  budget: ImportMapBudget,
): ParsedImportMap | null {
  const entriesBefore = budget.entries;
  const scopesBefore = budget.scopes;
  try {
    return parseImportMap(source, baseUrl, budget);
  } catch (err) {
    if (!(err instanceof ImportMapBudgetError)) throw err;
    // An over-limit map installs nothing and releases its counts for later document maps.
    budget.entries = entriesBefore;
    budget.scopes = scopesBefore;
    console.warn(`[kitesurf-walk] ignoring import map: ${err.message}`);
    return null;
  }
}

export function parseImportMaps(
  sources: readonly (string | { source: string; baseUrl: string })[],
  baseUrl: string,
  budget: ImportMapBudget = newImportMapBudget(),
): ParsedImportMap {
  const result: ParsedImportMap = { imports: new Map(), scopes: new Map() };
  for (const input of sources) {
    const source = typeof input === "string" ? input : input.source;
    const sourceBaseUrl = typeof input === "string" ? baseUrl : input.baseUrl;
    const map = parseDocumentImportMap(source, sourceBaseUrl, budget);
    if (map) mergeImportMap(result, map, [], budget);
  }
  return result;
}

function resolveInSpecifierMap(
  normalized: string,
  asUrl: URL | null,
  mappings: ReadonlyMap<string, string | null>,
  budget: ImportMapBudget,
): string | null | undefined {
  if (mappings.has(normalized)) return mappings.get(normalized);
  if (asUrl !== null && !SPECIAL_SCHEMES.has(asUrl.protocol)) return undefined;
  let bestKey = "";
  let bestAddress: string | null | undefined;
  for (const key of prefixKeys(mappings)) {
    chargeRuleComparison(budget, key.length, normalized.length);
    if (normalized.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
      const address = mappings.get(key);
      if (address === null || address === undefined) {
        bestAddress = null;
        continue;
      }
      try {
        const resolved = new URL(normalized.slice(key.length), address).href;
        bestAddress = resolved.startsWith(address) ? resolved : null;
      } catch {
        bestAddress = null;
      }
    }
  }
  return bestAddress;
}

export function importMapModuleSource(
  importMap: ParsedImportMap,
  registryNames: ReadonlyMap<string, string> = new Map(),
): string {
  const imports = JSON.stringify([...importMap.imports]);
  const scopes = JSON.stringify(
    scopesBySpecificity(importMap).map(([scope, mappings]) => [scope, [...mappings]]),
  );
  const registryAliases = JSON.stringify([...registryNames]);
  return `const imports=new Map(${imports});
 const scopes=${scopes}.map(([scope,mappings])=>[scope,new Map(mappings)]);
 const registryAliases=new Map(${registryAliases});
 const special=new Set(["ftp:","file:","http:","https:","ws:","wss:"]);
 function asUrl(s,base){try{return s.startsWith("/")||s.startsWith("./")||s.startsWith("../")?new URL(s,base):new URL(s)}catch{return null}}
 function inMap(normalized,url,mappings){if(mappings.has(normalized))return mappings.get(normalized);if(url!==null&&!special.has(url.protocol))return undefined;let best="",answer;for(const [key,address] of mappings){if(!key.endsWith("/")||!normalized.startsWith(key)||key.length<=best.length)continue;best=key;if(address===null){answer=null;continue}try{const resolved=new URL(normalized.slice(key.length),address).href;answer=resolved.startsWith(address)?resolved:null}catch{answer=null}}return answer}
 export function resolveImportMap(specifier,importer){specifier=String(specifier);const url=asUrl(specifier,importer);const normalized=url?url.href:specifier;for(const [scope,mappings] of scopes){if(scope!==importer&&(!scope.endsWith("/")||!importer.startsWith(scope)))continue;const resolved=inMap(normalized,url,mappings);if(resolved===undefined)continue;if(resolved===null)throw new TypeError("Import map blocked module specifier: "+specifier);return resolved}const mapped=inMap(normalized,url,imports);if(mapped!==undefined){if(mapped===null)throw new TypeError("Import map blocked module specifier: "+specifier);return mapped}if(url===null)throw new TypeError("Bare module specifier requires an import map: "+specifier);return normalized}
 export function resolveModuleRegistryUrl(url){url=String(url);const name=registryAliases.get(url)??url;if(!/^https?:\\/\\//.test(name))throw new TypeError("Not a page module URL: "+url);return name}
 `;
}

export const FALLBACK_MODULE_RESOLVER_SOURCE = importMapModuleSource({
  imports: new Map(),
  scopes: new Map(),
});

export function resolveImportMapSpecifier(
  specifier: string,
  importer: string,
  importMap: ParsedImportMap,
  budget: ImportMapBudget = newImportMapBudget(),
): string | null {
  // Fail closed once the budget is spent: resolving without the map could run an import the
  // map would have blocked.
  if (budget.degraded) return null;
  const asUrl = parseUrlLikeSpecifier(specifier, importer);
  const normalized = asUrl?.href ?? specifier;
  // One parse, normalization and exact-map hash lookup per resolution; the scope and prefix
  // scans below are charged per comparison.
  chargeResolution(budget, normalized.length);
  for (const [scope, mappings] of scopesBySpecificity(importMap)) {
    chargeScopeComparison(budget, scope.length, importer.length);
    if (!scopeMatches(scope, importer)) continue;
    const resolved = resolveInSpecifierMap(normalized, asUrl, mappings, budget);
    if (resolved !== undefined) return resolved;
  }
  const mapped = resolveInSpecifierMap(normalized, asUrl, importMap.imports, budget);
  if (mapped !== undefined) return mapped;
  return asUrl?.href ?? null;
}

export function documentBaseUrl(pageUrl: string, baseHref: string | null | undefined): string {
  if (!baseHref) return pageUrl;
  try {
    return new URL(baseHref, pageUrl || undefined).toString();
  } catch {
    return pageUrl;
  }
}

export interface GatedImportMap {
  source: string;
  baseUrl: string;
  scriptDomIndex: number;
}

export async function applyImportMapGate(
  importMaps: readonly ScannedImportMap[],
  gate: ScriptGateContext,
  pageUrl: string,
): Promise<GatedImportMap[]> {
  const out: GatedImportMap[] = [];
  for (const map of importMaps) {
    if (!scriptGateIsNoop(gate)) {
      const decision = await checkScriptBeforeFetch(gate, {
        url: null,
        nonce: map.nonce,
        body: map.body,
        runtimeInserted: false,
        module: false,
      });
      if (decision.reportOnly) {
        console.warn(`[kitesurf-csp] ${decision.reportOnly}`);
      }
      if (!decision.allowed) {
        console.warn(
          `[kitesurf-csp] blocked (${decision.reason ?? "csp"}) import map: ` +
            (decision.message ?? "blocked by policy"),
        );
        continue;
      }
    }
    out.push({
      source: map.body,
      baseUrl: documentBaseUrl(pageUrl, map.baseHref),
      scriptDomIndex: map.scriptDomIndex,
    });
  }
  return out;
}
