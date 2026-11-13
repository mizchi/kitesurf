// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Loads each page generation's PageScript isolate and wires its RPC, egress, and tails.

import type Protocol from "devtools-protocol";
import { pageIsolateEntry } from "./page-isolate-entry.ts";
import wasmGlueSource from "../../../core/pkg/kitesurf_core.glue.js";
import { DOM_SHIM_SOURCE } from "@kitesurf/dom-shim";
import { INTERNAL_STATE_SOURCE, PAGE_SCRIPT_SOURCE } from "@kitesurf/page-script";
import type { RenderPortStub } from "@kitesurf/jsrpc-types/page-renderer";
import type { SandboxRestrictions } from "@kitesurf/script-gate";
import type {
  PageScriptBootstrap,
  PageScriptEntrypoint,
  PageScriptEntrypointStub,
  PageScriptSession,
  ReceivedUpstreamParams,
  UpstreamEventName,
} from "@kitesurf/jsrpc-types/page-script";

export type UpstreamEventHandler = (
  event: UpstreamEventName,
  params: ReceivedUpstreamParams,
) => void;
import type {
  ConsoleEntry,
  ExceptionEntry,
  PackedException,
  PackedResult,
} from "@kitesurf/jsrpc-types/shared";
import type { OutboundProps } from "./outbound.ts";
import {
  openPageScriptRpcSession,
  type RpcSessionCallable,
  type RpcSessionEntrypoint,
} from "./page-script-rpc-session.ts";
import { traceSpan, type Tracer } from "../tracing.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { MAX_DOCUMENT_BYTES } from "../read-capped.ts";
import { attributionTails, type AttributionTailExports } from "./attribution-tail.ts";
import { makeWallClock, type HostClock } from "./host-clock.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import fs from "node:fs";
import type { ParentScriptDescriptor } from "../wasm.ts";
import type { ScriptBundle } from "./script-bundle.ts";
import { FALLBACK_MODULE_RESOLVER_SOURCE } from "./walk-module-graph.ts";
import type { WasmBake } from "./prefetch-wasm.ts";

const cachedWasmBytes = new Map<string, ArrayBuffer>();
export function loadWasmBytesFromVfs(filename = "kitesurf_core_bg.wasm"): ArrayBuffer {
  const cached = cachedWasmBytes.get(filename);
  if (cached) return cached;
  const entries = fs.readdirSync("/bundle");
  const name = entries.find((n) => n.endsWith(`-${filename}`) || n === filename);
  if (!name) {
    throw new Error(
      `page-script: could not find ${filename} in /bundle. Entries: ${entries.join(", ")}`,
    );
  }
  const buf = fs.readFileSync(`/bundle/${name}`);
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  cachedWasmBytes.set(filename, out);
  return out;
}

export interface PageScriptStub extends PageScriptSession {
  /** Identity this isolate stamps into its Runtime handles and compiled-script ids. */
  isolateStamp?: string;
  close?(reason?: string): void;
  killIsolate?(reason?: string, opts?: { atOnce?: boolean }): Promise<unknown> | void;
  setUpstreamEventHandler?(handler: UpstreamEventHandler | null): void;
  armAwaitLoad?(): void;
  getRenderPort(): Promise<RenderPortStub>;
}

type CtxWithExports = ExecutionContext & {
  exports: AttributionTailExports & {
    SandboxOutbound(opts: { props: OutboundProps }): Fetcher;
    PageScriptTail(opts: {
      props: {
        scriptName: string;
        pageDomain?: string;
        ksErrToken?: string;
        sessionId?: string;
      };
    }): Fetcher;
    SpanSink(opts: { props: { kind: string } }): unknown;
  };
};

export const PAGE_SCRIPT_COMPAT_DATE = "2026-09-11";
export const PAGE_SCRIPT_COMPAT_FLAGS: readonly string[] = [
  "new_module_registry",
  "no_nodejs_compat",
  "no_nodejs_compat_v2",
];

export const PAGE_SCRIPT_SUBREQUEST_CAP = 10_000;

const PAGE_SCRIPT_CPU_TIME_MS_CAP = 300_000;

export interface PageIsolateCapOverrides {
  cpuMs?: number;
  wallMs?: number;
}

// Effective per-page-isolate budgets. cpuMs always > 0 (defaults to
// the plan maximum); wallMs 0 = uncapped (the default without a deployment cap).
export interface PageIsolateCaps {
  cpuMs: number;
  wallMs: number;
}

// Env-tunable isolate caps (a deployment may set both): CPU rides
// the Worker Loader's limits.cpuMs, wall arms the session kill timer.
export function pageIsolateCaps(
  env: {
    KITESURF_PAGE_CPU_MS_CAP?: string;
    KITESURF_PAGE_WALL_MS_CAP?: string;
  },
  overrides?: PageIsolateCapOverrides,
): PageIsolateCaps {
  const envCpu = parseCapMs(env.KITESURF_PAGE_CPU_MS_CAP);
  const envWall = parseCapMs(env.KITESURF_PAGE_WALL_MS_CAP);
  return {
    cpuMs: minCap(envCpu || PAGE_SCRIPT_CPU_TIME_MS_CAP, overrides?.cpuMs),
    wallMs: minCap(envWall, overrides?.wallMs),
  };
}

function parseCapMs(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function minCap(configured: number, override: number | undefined): number {
  const o = override && override > 0 ? Math.floor(override) : 0;
  if (configured > 0 && o > 0) return Math.min(configured, o);
  return configured > 0 ? configured : o;
}

export interface PageScriptKey {
  connectionId: string;
  targetId: string;
  cookieKey?: string;
  navigateGeneration: number;
  lazy?: boolean;
  frameId?: string;
}

const PAGE_SCRIPT_FRAME_ID_KEY_PREFIX_CHARS = 8;

export function pageScriptCacheKey(k: PageScriptKey): string {
  const lazySuffix = k.lazy ? "-lazy" : "";
  const frameSuffix = k.frameId
    ? `-oopif-${k.frameId.slice(0, PAGE_SCRIPT_FRAME_ID_KEY_PREFIX_CHARS)}`
    : "";
  return `page-${k.connectionId}-${k.targetId}-${k.navigateGeneration}${lazySuffix}${frameSuffix}`;
}

export interface PageScriptStartupInput {
  html: string | null;
  url: string | null;
  cookies: string;
  scriptDescriptors: ParentScriptDescriptor[];
  scriptBundle: ScriptBundle | null;
  wasmBake: WasmBake | null;
  userAgent: string | null;
  referrerPolicy?: string | null;
  referrer?: string | null;
  csp?: string[];
  metaCsp?: string[];
  cdpDebug: boolean;
  pixelFree: boolean;
  fontDefer?: boolean;
}

function emptyWasmBytes(): ArrayBuffer {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer;
}

interface GetOrCreatePageScriptOptions {
  env: {
    LOADER: WorkerLoader;
    KITESURF_SIMULATE_PROD_EVAL?: string;
    KITESURF_RESOURCE_DRAIN_QUIET_TURNS?: string;
    KITESURF_LAG_WATCHDOG?: string;
    KITESURF_PAGE_CPU_MS_CAP?: string;
    KITESURF_PAGE_WALL_MS_CAP?: string;
    HOST_TRACER?: Tracer;
    HOST_CLOCK?: HostClock;
  };
  ctx: ExecutionContext;
  key: PageScriptKey;
  pageOrigin: string;
  cookieSiteOrigin?: string;
  startupInput?: Partial<PageScriptStartupInput>;
  attributionHeaders?: Record<string, string>;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  initTimings: PageScriptInitTimings | undefined;
  capOverrides: PageIsolateCapOverrides | undefined;
  sandboxOutbound: SandboxOutboundOverride;
  /** Extra modules and the host class name for this isolate (EngineHost.pageIsolate). */
  pageIsolate?: { modules?: Record<string, string>; hostClassName?: string };
}

/** Loads one PageScript worker for the supplied target generation and returns its RPC adapter. */
export function getOrCreatePageScript({
  env,
  ctx,
  key,
  pageOrigin,
  cookieSiteOrigin,
  startupInput = {},
  attributionHeaders = {},
  mainLoaderId = "",
  extraHeaders = {},
  initTimings,
  capOverrides,
  sandboxOutbound,
  pageIsolate,
}: GetOrCreatePageScriptOptions): PageScriptStub {
  const cx = ctx as CtxWithExports;
  const wall = makeWallClock(env);
  const name = pageScriptCacheKey(key);
  const caps = pageIsolateCaps(env, capOverrides);
  // Authenticates the child's [ks-err] engine error channel (see engine-errors.ts
  // parseKsErrLine): page JS can spoof console prefixes, not this.
  const tailToken = crypto.randomUUID();
  // Routes Runtime handles and compiled-script ids back to the isolate that minted them.
  const isolateStamp = crypto.randomUUID();

  const html = typeof startupInput.html === "string" ? startupInput.html : null;
  const url = typeof startupInput.url === "string" ? startupInput.url : null;
  const cookies = typeof startupInput.cookies === "string" ? startupInput.cookies : "";
  // The classic bundle already carries every body. A copy here stayed live as
  // module text and literals for the page's life: ~11 MiB of V8 heap on a large single-page app.
  const scriptDescriptors = (
    Array.isArray(startupInput.scriptDescriptors) ? startupInput.scriptDescriptors : []
  ).map(({ prefetchedSource, ...d }) =>
    typeof prefetchedSource === "string" ? { ...d, prefetchedLength: prefetchedSource.length } : d,
  );
  const userAgent =
    typeof startupInput.userAgent === "string" && startupInput.userAgent
      ? startupInput.userAgent
      : null;
  const referrer = typeof startupInput.referrer === "string" ? startupInput.referrer : "";
  const referrerPolicy =
    typeof startupInput.referrerPolicy === "string" ? startupInput.referrerPolicy : "";
  const cdpDebug = startupInput.cdpDebug === true;
  const pixelFree = startupInput.pixelFree === true;
  const fontDefer = startupInput.fontDefer === true;
  const configuredQuietTurns = Number.parseInt(env.KITESURF_RESOURCE_DRAIN_QUIET_TURNS ?? "", 10);
  const resourceDrainQuietTurns = Number.isFinite(configuredQuietTurns)
    ? Math.max(1, configuredQuietTurns)
    : 1;
  const lagWatchdog = cdpDebug || env.KITESURF_LAG_WATCHDOG === "1";
  const scriptBundle = startupInput.scriptBundle ?? null;
  const wasmBake = startupInput.wasmBake ?? null;
  const moduleScriptUrls = scriptBundle ? scriptBundle.moduleScriptUrls : [];
  const moduleScriptCount = moduleScriptUrls.length;
  // A baked JSON record's namespace is only trustworthy for an import that asks for JSON.
  const jsonModuleUrls = scriptBundle
    ? Object.entries(scriptBundle.additionalModules)
        .filter(([, baked]) => typeof baked !== "string")
        .map(([url]) => url)
    : [];
  const hasClassicRegular = !!(scriptBundle && scriptBundle.classicRegularSource);
  const hasClassicAsync = !!(scriptBundle && scriptBundle.classicAsyncSource);
  const csp = Array.isArray(startupInput.csp) ? startupInput.csp : [];
  const metaCsp = Array.isArray(startupInput.metaCsp) ? startupInput.metaCsp : [];

  const bootstrap = {
    html,
    url,
    cookies,
    scriptDescriptors,
    userAgent,
    referrer,
    referrerPolicy,
    hasClassicRegular,
    hasClassicAsync,
    moduleScriptCount,
    moduleScriptUrls,
    jsonModuleUrls,
    cdpDebug,
    lagWatchdog,
    pixelFree,
    fontDefer,
    resourceDrainQuietTurns,
    csp,
    metaCsp,
    insertedBaked: scriptBundle?.insertedManifest ?? [],
  } satisfies PageScriptBootstrap;
  const startupInputModule = Object.entries(bootstrap)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join("\n");

  const modules: Record<
    string,
    string | { wasm: ArrayBuffer } | { cjs: string } | { js: string } | { json: unknown }
  > = {
    "page.js": PAGE_SCRIPT_SOURCE,
    "dom-shim.js": DOM_SHIM_SOURCE,
    "internal-state.js": INTERNAL_STATE_SOURCE,
    "wasm-glue.js": wasmGlueSource,
    "core_bg.wasm": { wasm: loadWasmBytesFromVfs() },
    "__ks_startup_probe_input.js": startupInputModule,
    "__ks_import_map.js": scriptBundle?.importMapModuleSource ?? FALLBACK_MODULE_RESOLVER_SOURCE,
  };
  if (scriptBundle && scriptBundle.classicRegularSource) {
    modules["__ks_user_classic_regular.js"] = {
      cjs: scriptBundle.classicRegularSource,
    };
  }
  if (scriptBundle && scriptBundle.preNavSource) {
    modules["__ks_user_pre_nav.js"] = {
      cjs: scriptBundle.preNavSource,
    };
  }
  if (scriptBundle && scriptBundle.classicAsyncSource) {
    modules["__ks_user_classic_async.js"] = {
      cjs: scriptBundle.classicAsyncSource,
    };
  }
  for (const [name, cjs] of Object.entries(scriptBundle?.insertedModules ?? {})) {
    modules[name] = { cjs };
  }
  if (scriptBundle) {
    for (const [url, baked] of Object.entries(scriptBundle.additionalModules)) {
      if (Object.prototype.hasOwnProperty.call(modules, url)) continue;
      modules[url] = typeof baked === "string" ? { js: baked } : baked;
    }
  }

  modules["__ks_empty.wasm"] = { wasm: emptyWasmBytes() };
  const registryImports: string[] = ['import __ksEmpty from "./__ks_empty.wasm";'];
  const registryEntries: string[] = [];
  if (wasmBake) {
    let wi = 0;
    for (const [wUrl, wBytes] of Object.entries(wasmBake.modules)) {
      const key = `__ks_baked_wasm_${wi}.wasm`;
      modules[key] = { wasm: wBytes };
      registryImports.push(`import __w${wi} from ${JSON.stringify(`./${key}`)};`);
      registryEntries.push(`  ${JSON.stringify(wUrl)}: __w${wi},`);
      wi++;
    }
  }
  modules["__ks_wasm_registry.js"] = `// AUTO-GENERATED per navigate by getOrCreatePageScript.
// Parent-baked wasm modules; matching in wasm-baked.ts.
${registryImports.join("\n")}
export const emptyModule = __ksEmpty;
export const bakedWasm = {
${registryEntries.join("\n")}
};
export const manifest = ${JSON.stringify(wasmBake ? wasmBake.manifest : {})};
`;

  const outboundProps = {
    ...localTraceParentProps(),
    pageOrigin,
    ...(cookieSiteOrigin !== undefined ? { cookieSiteOrigin } : {}),
    pageUrl: url ?? undefined,
    referrerPolicy:
      typeof startupInput.referrerPolicy === "string" ? startupInput.referrerPolicy : undefined,
    mainFrameId: key.frameId ?? key.targetId,
    mainLoaderId,
    extraHeaders,
    connectionId: key.connectionId,
    cookieKey: key.cookieKey ?? "",
    pixelFree,
  };
  const mainModule = pageIsolateEntry(modules, pageIsolate);
  const stub = env.LOADER.load({
    compatibilityDate: PAGE_SCRIPT_COMPAT_DATE,
    compatibilityFlags: [...PAGE_SCRIPT_COMPAT_FLAGS],
    mainModule,
    modules,
    // Page modules run in this worker and can import its env, so the tail
    // token goes in the entrypoint props below instead.
    env: {
      ...(env.HOST_TRACER
        ? {
            KS_SPAN_SINK: cx.exports.SpanSink({
              props: { kind: "pagescript", ...localTraceParentProps() },
            }),
          }
        : {}),
    },
    globalOutbound: sandboxOutbound.loaded(outboundProps),
    tails: [
      cx.exports.PageScriptTail({
        props: {
          scriptName: name,
          // Navigate-time domain for error reports; a
          // [ks-err] report's live pageUrl wins over it (SPA routing).
          pageDomain: hostnameOf(url ?? ""),
          ksErrToken: tailToken,
          sessionId: key.connectionId,
        },
      }),
      ...attributionTails(cx.exports, attributionHeaders, "kitesurf-page-script"),
    ],
    limits: {
      cpuMs: caps.cpuMs,
      subRequests: PAGE_SCRIPT_SUBREQUEST_CAP,
    },
  });

  const workerEntrypoint: PageScriptEntrypointStub = stub.getEntrypoint<PageScriptEntrypoint>(
    "PageScript",
    {
      props: { KS_TAIL_TOKEN: tailToken, KS_ISOLATE_STAMP: isolateStamp },
    },
  );
  // The RPC adapter needs promises; the local entrypoint contract is synchronous.

  // SAFETY: WorkerLoader follows the PageScript JSRPC contract, but Rpc.Provider loses generic
  // call/reply correlation and annotates cloneable reply objects with Disposable.
  // Runtime replies remain PageScriptReply data.
  // Verified by: packages/engine/test/e2e/demos/page-script-demo.e2e.test.ts.
  const entrypoint = workerEntrypoint as RpcSessionEntrypoint;
  const tracer = env.HOST_TRACER;
  const spanWrap = tracer
    ? (open: () => Promise<RpcSessionCallable>) =>
        traceSpan(tracer, "init.ws_upgrade", () => open())
    : undefined;
  const wrapOpen = initTimings
    ? async (open: () => Promise<RpcSessionCallable>) => {
        const t0 = wall();
        try {
          return await (spanWrap ? spanWrap(open) : open());
        } finally {
          initTimings.wsUpgradeMs = wall() - t0;
        }
      }
    : spanWrap;
  const session = openPageScriptRpcSession(entrypoint, {
    now: makeWallClock(env),
    outbound: sandboxOutbound.session(outboundProps),
    wallCapMs: caps.wallMs > 0 ? caps.wallMs : undefined,
    scriptName: name,
    getTraceParent: tracer ? () => tracer.getSpanContext()?.spanId ?? null : undefined,
    wrapOpen,
  });
  session.isolateStamp = isolateStamp;
  return session;
}

export interface PageScriptInitTimings {
  wsUpgradeMs?: number;
}

export function spawnFramePageScript(
  env: {
    LOADER: WorkerLoader;
    KITESURF_SIMULATE_PROD_EVAL?: string;
    KITESURF_LAG_WATCHDOG?: string;
  },
  ctx: ExecutionContext,
  args: {
    connectionId: string;
    targetId: string;
    frameId: string;
    frameLoaderId: string;
    frameUrl: string;
    // The child document's active sandbox restrictions; absent means no restrictions.
    sandbox: SandboxRestrictions;
    cookieKey?: string;
    cookieSiteOrigin?: string;
    extraHeaders?: Record<string, string>;
    attributionHeaders?: Record<string, string>;
    sandboxOutbound: SandboxOutboundOverride;
  },
): PageScriptStub {
  const sandbox = args.sandbox;
  // Without allow-same-origin the isolate's outbound identity is opaque, never the URL's origin.
  const pageOrigin = sandbox.sameOrigin ? originOf(args.frameUrl) : "";
  const key: PageScriptKey = {
    connectionId: args.connectionId,
    targetId: args.targetId,
    navigateGeneration: Date.now(),
    frameId: args.frameId,
    cookieKey: args.cookieKey,
  };
  return getOrCreatePageScript({
    env,
    ctx,
    key,
    pageOrigin,
    cookieSiteOrigin: args.cookieSiteOrigin,
    startupInput: {},
    attributionHeaders: args.attributionHeaders ?? {},
    mainLoaderId: args.frameLoaderId,
    extraHeaders: args.extraHeaders ?? {},
    initTimings: undefined,
    capOverrides: undefined,
    sandboxOutbound: args.sandboxOutbound,
  });
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function originOf(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.host) return "";
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

const VALUE_SIZE_LIMIT_TEXT = "Runtime result exceeds the value size limit";

// True when text is at most MAX_DOCUMENT_BYTES UTF-8 bytes. A UTF-16 unit encodes to at most
// 3 bytes, so only long text needs its code points counted.
export function valueJsonWithinLimit(text: string): boolean {
  if (text.length > MAX_DOCUMENT_BYTES) return false;
  if (text.length * 3 <= MAX_DOCUMENT_BYTES) return true;
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes > MAX_DOCUMENT_BYTES) return false;
  }
  return true;
}

export function pageScriptResultToCdp(
  res: PackedResult | PackedException,
  returnByValue: boolean,
): Protocol.Runtime.EvaluateResponse {
  if (!res.ok) {
    return {
      result: {
        type: "object",
        subtype: "error",
        className: res.exception.className,
        description: res.exception.message,
      },
      exceptionDetails: {
        exceptionId: 1,
        text: res.exception.text,
        lineNumber: 0,
        columnNumber: 0,
        exception: {
          type: "object",
          subtype: "error",
          className: res.exception.className,
          description: res.exception.stack || res.exception.message,
        },
      },
    };
  }

  const remote: Protocol.Runtime.RemoteObject = { type: res.type };
  if (res.subtype) remote.subtype = res.subtype;
  if (res.className) remote.className = res.className;
  if (res.description) remote.description = res.description;

  const isPrimitiveType =
    res.type === "string" ||
    res.type === "number" ||
    res.type === "boolean" ||
    res.type === "bigint" ||
    res.type === "undefined";
  const wantValue = isPrimitiveType || returnByValue;
  // The page realm can replace JSON.stringify, so the reply's value text may not be a string.
  if (wantValue && typeof res.valueJson === "string") {
    if (!valueJsonWithinLimit(res.valueJson)) {
      const error: Protocol.Runtime.RemoteObject = {
        type: "object",
        subtype: "error",
        className: "Error",
        description: VALUE_SIZE_LIMIT_TEXT,
      };
      return {
        result: error,
        exceptionDetails: {
          exceptionId: 1,
          text: VALUE_SIZE_LIMIT_TEXT,
          lineNumber: 0,
          columnNumber: 0,
          exception: error,
        },
      };
    }
    try {
      remote.value = JSON.parse(res.valueJson);
    } catch {}
  }
  if (res.subtype === "null") remote.value = null;

  if (!("value" in remote) && (res.type === "object" || res.type === "function")) {
    remote.objectId = res.objectId ?? `eval:${crypto.randomUUID()}`;
  }
  if (remote.type === "object" && !remote.subtype && typeof res.description === "string") {
    const d = res.description;
    if (
      d === "Element" ||
      d === "HTMLElement" ||
      d === "DocumentImpl" ||
      d === "Document" ||
      d === "XMLDocument" ||
      d === "TextNode" ||
      d === "Text" ||
      d === "CommentNode" ||
      d === "Comment" ||
      d === "CharacterData" ||
      d === "DocumentFragmentImpl" ||
      d === "DocumentFragment" ||
      d === "ShadowRoot" ||
      d === "DocumentTypeNode" ||
      d === "DocumentType" ||
      d === "Attr" ||
      d === "Node" ||
      /^HTML[A-Z][A-Za-z0-9]*Element$/.test(d)
    ) {
      remote.subtype = "node";
    }
  }

  return { result: remote };
}

function consoleArgToRemote(arg: PackedResult): Protocol.Runtime.RemoteObject {
  const remote: Protocol.Runtime.RemoteObject = { type: arg.type };
  if (arg.subtype) remote.subtype = arg.subtype;
  if (typeof arg.className === "string" && arg.className) remote.className = arg.className;
  if (typeof arg.description === "string") remote.description = arg.description;
  if (typeof arg.valueJson === "string" && valueJsonWithinLimit(arg.valueJson)) {
    try {
      remote.value = JSON.parse(arg.valueJson);
    } catch {}
  }
  if (arg.subtype === "null") remote.value = null;
  return remote;
}

function levelToCdpType(level: string): Protocol.Runtime.ConsoleAPICalledEvent["type"] {
  switch (level) {
    case "log":
    case "info":
    case "warning":
    case "error":
    case "debug":
    case "trace":
    case "dir":
    case "table":
      return level;
    default:
      return "log";
  }
}

function parseTopFrame(
  stack: string,
  preferUrl: string,
): { url: string; line: number; col: number } | null {
  if (!stack) return null;
  const frameRe = /\bat\s+(?:.*?\s+\()?([^\s()]+):(\d+):(\d+)\)?\s*$/;
  let fallback: { url: string; line: number; col: number } | null = null;
  for (const line of stack.split("\n")) {
    const m = frameRe.exec(line);
    if (!m) continue;
    const frame = { url: m[1]!, line: Number(m[2]!), col: Number(m[3]!) };
    if (preferUrl && frame.url === preferUrl) return frame;
    if (!fallback) fallback = frame;
  }
  return fallback;
}

export function exceptionEntryToCdpEvent(
  entry: ExceptionEntry,
  exceptionId: number,
  executionContextId?: number,
): {
  method: "Runtime.exceptionThrown";
  params: Protocol.Runtime.ExceptionThrownEvent;
} {
  const top = parseTopFrame(entry.stack, entry.url);
  const lineNumber = top ? Math.max(0, top.line - 1) : 0;
  const columnNumber = top ? Math.max(0, top.col - 1) : 0;
  return {
    method: "Runtime.exceptionThrown",
    params: {
      timestamp: entry.timestamp,
      exceptionDetails: {
        exceptionId,
        text: entry.text,
        lineNumber,
        columnNumber,
        scriptId: entry.scriptId,
        url: entry.url,
        executionContextId: executionContextId ?? 1,
        exception: {
          type: "object",
          subtype: "error",
          className: entry.className,
          description: entry.stack || entry.message,
        },
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              scriptId: entry.scriptId,
              url: entry.url,
              lineNumber,
              columnNumber,
            },
          ],
        },
      },
    },
  };
}

export function consoleEntryToCdpEvent(
  entry: ConsoleEntry,
  executionContextId?: number,
): {
  method: "Runtime.consoleAPICalled";
  params: Protocol.Runtime.ConsoleAPICalledEvent;
} {
  return {
    method: "Runtime.consoleAPICalled",
    params: {
      type: levelToCdpType(entry.level),
      args: entry.args.map(consoleArgToRemote),
      executionContextId: executionContextId ?? 1,
      timestamp: entry.timestamp,
      stackTrace: { callFrames: [] },
    },
  };
}
