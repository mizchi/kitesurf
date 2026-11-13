// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines PageScript session methods, wire shapes, and upstream events.

import type {
  ConsoleEntry,
  ExceptionEntry,
  JsWindowDrain,
  PackedException,
  PackedResult,
} from "./shared.ts";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "./query-dom.ts";
import type { RenderPort } from "./page-renderer.ts";
import type { WorkerEventParams, WorkerNavigatorInfo } from "./dedicated-worker.ts";
import type { SandboxRestrictions } from "./sandbox.ts";
import type { CommittedOrigin } from "./frame-origin.ts";

export interface ModulePreloadPin {
  url: string;
  integrity: string | null;
}

export type { SandboxRestrictions } from "./sandbox.ts";
export type { CommittedOrigin } from "./frame-origin.ts";

/** Exports of the per-document `__ks_startup_probe_input.js` module. */
export interface PageScriptBootstrap {
  html: string | null;
  url: string | null;
  cookies: string;
  scriptDescriptors: Array<{
    src: string | null;
    kind: "classic" | "module";
    defer: boolean;
    async: boolean;
    body: string;
    prefetchedLength?: number;
    prefetchError?: string;
  }>;
  userAgent: string | null;
  referrer: string;
  referrerPolicy: string;
  hasClassicRegular: boolean;
  hasClassicAsync: boolean;
  moduleScriptCount: number;
  resourceDrainQuietTurns: number;
  pixelFree: boolean;
  fontDefer: boolean;
  moduleScriptUrls: string[];
  jsonModuleUrls: string[];
  cdpDebug: boolean;
  lagWatchdog: boolean;
  csp: string[];
  metaCsp: string[];
  insertedBaked: Array<{ url: string; module: string; digest: string }>;
}

export interface NavigateOptions {
  cookies?: string;
  connectionId?: string;
  mainFrameId?: string;
  cookieKey?: string;
  // The effective iframe sandbox restrictions for this document, already intersected with its
  // ancestors. Absent means no restrictions.
  sandbox?: SandboxRestrictions;
  // The committed origins of this document's ancestors, nearest first. The engine supplies this
  // trusted snapshot for a child navigation; page script never derives it from the page.
  ancestorOrigins?: CommittedOrigin[];
  modulePreloadPins?: ModulePreloadPin[];
  scriptPolicy?: {
    cspHeaders: string[];
    cspReportOnlyHeaders: string[];
    metaCsp: string[];
  };
  bindingNames?: string[];
  charset?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  traced?: boolean;
  expectIframeInstalls?: boolean;
  darkColorScheme?: boolean;
  ttyUaCss?: number;
  ttyCss?: string;
  ttyCellW?: number;
  ttyCellH?: number;
}

export interface NavigateSummary extends Partial<JsWindowDrain> {
  readyState?: "interactive";
  title: string;
  nodeCount: number;
  documentNodeId: number;
  url: string;
  scriptCount?: number;
  exceptions?: ExceptionEntry[];
  phases?: Record<string, number>;
  bundleExec?: string[];
  fontDegradedReads?: number;
}

export interface LoadCompletion extends JsWindowDrain {
  phases: Record<string, number>;
  exceptions?: ExceptionEntry[];
  readyAt?: number;
  sentAt?: number;
}

export interface OkReply {
  ok: true;
}

export interface UnloadReply extends OkReply {
  console?: ConsoleEntry[];
  cookieWrites?: string[];
}

export interface DrainConsoleReply extends JsWindowDrain {
  exceptions?: ExceptionEntry[];
  documentReopened?: boolean;
}

export interface EvalOptions {
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export interface CallFunctionOnOptions extends EvalOptions {
  thisObjectId?: string;
}

export interface ArgSpec {
  json?: string;
  objectId?: string;
}

export type EvalResult = (PackedResult | PackedException) &
  JsWindowDrain & { documentReopened: boolean };

export interface PropertyDescriptor {
  name: string;
  configurable: boolean;
  enumerable: boolean;
  isOwn: boolean;
  writable?: boolean;
  value?: PackedResult;
  get?: PackedResult;
  set?: PackedResult;
}

export type RunScriptReply =
  | EvalResult
  | (PackedException & Partial<JsWindowDrain> & { documentReopened?: boolean });

export type CompileScriptReply = { ok: true; scriptId: string | null } | PackedException;

export interface IframeContentParams {
  frameId: string;
  ownerBackendNodeId: number;
  html: string;
  url: string;
  // The document base URL, which differs from `url` for a srcdoc child.
  baseUrl?: string;
  failed: boolean;
  mimeType?: string;
  crossOrigin?: boolean;
  // The child document's active restrictions. A facade without allow-scripts keeps no inline
  // handlers, because it is parsed in the embedder's realm.
  sandbox: SandboxRestrictions;
}

export interface FrameBitmapParams {
  ownerBackendNodeId: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface ClearFrameBitmapParams {
  ownerBackendNodeId: number;
}

export interface FrameBitmapReply {
  ok: boolean;
  rc: number;
  error?: string;
}

export interface DeliverMessageParams {
  dataJson: string;
  origin: string;
  sourceFrameOwnerId?: number;
  fromParent?: boolean;
}

export interface ModifierKeys {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface MouseEventInit extends ModifierKeys {
  bubbles: boolean;
  cancelable: boolean;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  detail: number;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
}

export interface KeyEventInit extends ModifierKeys {
  bubbles: boolean;
  cancelable: boolean;
  key: string;
  code: string;
  text: string;
  keyCode?: number;
  location?: number;
  repeat?: boolean;
  ttyKeyboard?: boolean;
}

export interface NavigatePost {
  url: string;
  postData?: string;
  postContentType?: string;
}

export interface KeyDispatchReply extends JsWindowDrain {
  defaultPrevented?: boolean;
  navigateTo?: string | null;
  navigatePost?: NavigatePost | null;
}

export interface MouseDispatchReply extends KeyDispatchReply {
  hashNavigateTo?: string | null;
}

export interface PageScriptSession {
  /** Resolves at DOMContentLoaded while the session continues the resource drain. */
  navigate(html: string, url: string, opts?: NavigateOptions): Promise<NavigateSummary>;
  /** Waits for the bounded resource drain, `load`, and post-load tasks during navigation.
   * Resource draining has a 25-second budget; teardown can return partial results.
   * A pipelined call waits for `navigate` to publish the drain.
   */
  awaitLoad(): Promise<LoadCompletion>;
  unload(): Promise<UnloadReply>;
  drainConsole(): Promise<DrainConsoleReply>;
  syncCookies(cookies: string): Promise<OkReply>;
  installBindings(names: string[]): Promise<OkReply>;
  installIframeContent(params: IframeContentParams): Promise<OkReply>;
  iframeInstallsSettled(): Promise<OkReply>;
  setFrameBitmap(params: FrameBitmapParams): Promise<FrameBitmapReply>;
  /** Clears a previously displayed child bitmap, e.g. when its next document is refused. */
  clearFrameBitmap(params: ClearFrameBitmapParams): Promise<OkReply>;
  deliverMessage(params: DeliverMessageParams): Promise<{ ok: boolean; error?: string }>;
  deliverWorkerEvent(params: WorkerEventParams): Promise<OkReply>;
  evaluate(expression: string, opts: EvalOptions): Promise<EvalResult>;
  callFunctionOn(
    functionDeclaration: string,
    argSpecs: ArgSpec[],
    opts: CallFunctionOnOptions,
  ): Promise<EvalResult>;
  releaseObject(objectId: string): Promise<OkReply>;
  getProperties(
    objectId: string,
    opts: { ownProperties?: boolean },
  ): Promise<{ result: PropertyDescriptor[] }>;
  compileScript(
    expression: string,
    sourceURL: string,
    persistScript: boolean,
  ): Promise<CompileScriptReply>;
  runScript(scriptId: string, opts: EvalOptions): Promise<RunScriptReply>;
  /** Runs one typed DOM operation in this generation; await dependent operations in order. */
  queryDom<M extends QueryDomMethod>(method: M, args: QueryDomArgs<M>): Promise<QueryDomResult<M>>;
  dispatchMouseEvent(type: string, init: MouseEventInit): Promise<MouseDispatchReply>;
  dispatchKeyEvent(type: string, init: KeyEventInit): Promise<KeyDispatchReply>;
}

export type PageScriptMethod = keyof PageScriptSession;

export type PageScriptReply<M extends PageScriptMethod> = Awaited<ReturnType<PageScriptSession[M]>>;

type NoParams = Record<string, never>;

export interface PageScriptWireParams {
  navigate: { html: string; url: string; opts?: NavigateOptions };
  awaitLoad: NoParams;
  unload: NoParams;
  drainConsole: NoParams;
  syncCookies: { cookies: string };
  installBindings: { names: string[] };
  installIframeContent: IframeContentParams;
  iframeInstallsSettled: NoParams;
  setFrameBitmap: FrameBitmapParams;
  clearFrameBitmap: ClearFrameBitmapParams;
  deliverMessage: DeliverMessageParams;
  deliverWorkerEvent: WorkerEventParams;
  evaluate: { expression: string; opts?: EvalOptions };
  callFunctionOn: {
    functionDeclaration: string;
    argSpecs?: ArgSpec[];
    opts?: CallFunctionOnOptions;
  };
  releaseObject: { objectId: string };
  getProperties: { objectId: string; opts?: { ownProperties?: boolean } };
  compileScript: { expression: string; sourceURL: string; persistScript: boolean };
  runScript: { scriptId: string; opts?: EvalOptions };
  queryDom: { method: QueryDomMethod; args?: QueryDomArgs<QueryDomMethod> };
  dispatchMouseEvent: { type: string; init: MouseEventInit };
  dispatchKeyEvent: { type: string; init: KeyEventInit };
}

export type PageScriptArgBuilders = {
  [M in PageScriptMethod]: (params: PageScriptWireParams[M]) => Parameters<PageScriptSession[M]>;
};

export interface WireMeta {
  t: number;
  tp?: string;
}

export interface RetainedPageScriptSession {
  // Replies must remain cloneable data; a returned function becomes a live RPC capability.
  call<M extends PageScriptMethod>(
    method: M,
    params: PageScriptWireParams[M],
    meta: WireMeta,
  ): Promise<PageScriptReply<M>>;
  /** Mints a renderer pull port attached to this retained PageScript generation. */
  makeRenderPort(): RenderPort & Rpc.RpcTargetBranded;
  close(): Promise<void>;
}

export type RetainedPageScriptSessionTarget = RetainedPageScriptSession & Rpc.RpcTargetBranded;
export type RetainedPageScriptSessionStub = Rpc.Stub<RetainedPageScriptSessionTarget>;

export interface ReceivedSessionInit {
  upstream?: Rpc.Stub<OpenSessionInit["upstream"]>;
  outbound?: Rpc.Stub<NonNullable<OpenSessionInit["outbound"]>>;
}

export type PageScriptEntrypoint = PageScriptSession & {
  // Use the retained-session form for live DOM; entrypoint calls can hit a cold sibling isolate.
  makeRenderPort(): RenderPort & Rpc.RpcTargetBranded;
  openSession(init: OpenSessionInit): RetainedPageScriptSessionTarget;
  killIsolate(reason?: string): void;
} & Rpc.WorkerEntrypointBranded;

export type PageScriptEntrypointStub = Fetcher<PageScriptEntrypoint>;

export interface UpstreamEvents {
  "kitesurf.bindingCalled": { name: string; payload: string };
  "kitesurf.diag": { ev: "start" | "end"; op: string; t: number };
  "kitesurf.formSubmitNavigate": NavigatePost;
  "kitesurf.frameAttached": {
    frameId: string;
    ownerBackendNodeId: number;
    url: string;
    name?: string;
    id?: string;
    loading?: string;
    // The iframe's sandbox attribute at the navigation start; absent means no attribute.
    sandbox?: string | null;
  };
  "kitesurf.frameDetached": { frameId: string };
  "kitesurf.frameLifecycle": { frameId: string; name: "DOMContentLoaded" | "load" };
  "kitesurf.frameNavigated": { frameId: string; url: string; sandbox?: string | null };
  "kitesurf.frameStoppedLoading": { frameId: string };
  "kitesurf.insertedScriptRan": { url: string; bytes: number; run: "baked" | "stale" | "boa" };
  "kitesurf.modelContextToolsAdded": { tools: WebMcpTool[] };
  "kitesurf.modelContextToolsRemoved": { names: string[] };
  "kitesurf.navigatedWithinDocument": {
    url: string;
    navigationType: "fragment" | "historyApi" | "other";
    kind: string;
    previousUrl: string;
  };
  "kitesurf.paintDirty": Record<never, never>;
  // The wasm module trapped and is poisoned; `message` is the trap's.
  "kitesurf.wasmTerminated": { message: string };
  "kitesurf.postMessage": {
    toFrameOwnerId?: number;
    toParent?: true;
    dataJson: string;
    targetOrigin: string;
    // Set by the engine when it queues the message for a child frame, from the sender's
    // committed URL; page script never supplies it.
    sourceOrigin?: string;
  };
  "kitesurf.workerCreate": {
    workerId: number;
    url: string;
    name: string;
    source: string;
    navigator: WorkerNavigatorInfo;
  };
  "kitesurf.workerPostMessage": { workerId: number; data: unknown };
  "kitesurf.workerTerminate": { workerId: number };
}

export type UpstreamEventName = keyof UpstreamEvents;

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    autosubmit?: boolean;
  };
  backendNodeId?: number;
}

export type UpstreamMessage<E extends UpstreamEventName = UpstreamEventName> = {
  [K in E]: { event: K; params: UpstreamEvents[K] };
}[E];

export type ReceivedUpstreamParams = {
  readonly [
    K in {
      [E in UpstreamEventName]: keyof UpstreamEvents[E];
    }[UpstreamEventName]
  ]?: unknown;
};

export interface SessionOutboundRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | ReadableStream<Uint8Array> | null;
}

export type SessionOutbound = (request: SessionOutboundRequest) => Promise<Response>;

export interface OpenSessionInit {
  upstream: (message: UpstreamMessage) => void;
  outbound?: SessionOutbound;
}
