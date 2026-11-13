// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Initializes core WebAssembly on demand and exposes document, render, and font helpers.

import type { DocumentScriptMetadata } from "@kitesurf/script-gate/import-map";

import wasmModule from "../../core/pkg/kitesurf_core_bg.wasm";
import type { ParsedStyleSheet } from "@kitesurf/jsrpc-types/query-dom";
import { registerEngineWasmProbe } from "./engine-wasm-probe.ts";
import { setDomFactory } from "./cdp/dom-release.ts";
import {
  initSync,
  DomHandle,
  ks_parse_stylesheet_structured,
  ks_render_html_to_image,
  ks_scan_document,
  stripFontForShaping as ks_strip_font_for_shaping,
  __setBridgeFetchResource,
} from "kitesurf-core";

let coreWasmMemory: WebAssembly.Memory | null = null;
let coreWasmInitialBytes = 0;

export function getEngineWasmBytes(): number {
  return coreWasmMemory ? coreWasmMemory.buffer.byteLength : 0;
}

export function getEngineWasmInitialBytes(): number {
  return coreWasmInitialBytes;
}

let initialized = false;
// Delay initSync until a parent DOM or render operation needs the core instance.
function ensureInit(): void {
  if (initialized) return;
  __setBridgeFetchResource((_id: number, _url: string, _kind: string) => {});
  // Parent instances need no-op imports when the wasm is instrumented for memprof.
  const noopMemprofImports = new Proxy<WebAssembly.ModuleImports>({}, { get: () => () => {} });
  // Capture exported memory while initSync creates its otherwise-hidden instance.
  const OrigInstance = WebAssembly.Instance;
  // SAFETY: This view narrows the temporary mutation to WebAssembly.Instance only.
  // The platform declaration does not provide a mutable namespace-slot type.
  // Verified by: packages/engine/test/e2e/target-dom-reclaim.e2e.test.ts.
  const wasmNs = WebAssembly as { Instance: typeof WebAssembly.Instance };
  const instrumentedInstance = function Instance(
    module: WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) {
    if (imports && !imports.wmprof) {
      imports.wmprof = noopMemprofImports;
    }
    const inst = new OrigInstance(module, imports);
    if (inst.exports && inst.exports.memory instanceof WebAssembly.Memory) {
      coreWasmMemory = inst.exports.memory;
    }
    return inst;
  };
  Object.defineProperty(instrumentedInstance, "prototype", { value: OrigInstance.prototype });
  // SAFETY: The wrapper returns a native instance and preserves its prototype.
  // TypeScript cannot infer a constructor signature from this function expression.
  // Verified by: packages/engine/test/e2e/target-dom-reclaim.e2e.test.ts.
  // eslint-disable-next-line kitesurf/no-chained-type-assertions -- Dynamic wasm constructor bridge.
  wasmNs.Instance = instrumentedInstance as unknown as typeof WebAssembly.Instance;
  try {
    initSync({ module: wasmModule });
  } finally {
    wasmNs.Instance = OrigInstance;
  }
  coreWasmInitialBytes = getEngineWasmBytes();
  registerEngineWasmProbe({
    bytes: getEngineWasmBytes,
    initialBytes: getEngineWasmInitialBytes,
  });
  initialized = true;
}

export function createDom(html: string, baseUrl: string): DomHandle {
  ensureInit();
  return new DomHandle(html, baseUrl);
}

setDomFactory(createDom);

export interface ScannedScript {
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  crossOrigin: string | null;
  integrity: string | null;
  nonce: string | null;
  scriptDomIndex: number;
}

export interface ScannedIframe {
  src: string | null;
  srcdoc: string | null;
  sandbox: string | null;
  name: string | null;
  id: string | null;
  loading: string | null;
  docOrderIndex: number;
}

export interface ScannedModulePreload {
  href: string;
  nonce: string | null;
  integrity: string | null;
  crossOrigin?: string | null;
}

export interface DocScan extends DocumentScriptMetadata {
  title: string;
  baseHref: string | null;
  scripts: ScannedScript[];
  iframes: ScannedIframe[];
  modulePreloads: ScannedModulePreload[];
}

export function scanDocument(html: string): DocScan {
  ensureInit();
  return JSON.parse(ks_scan_document(html)) as DocScan;
}

export type ParsedStyleSheetRules = ParsedStyleSheet["rules"];

// Stylesheet text the page cannot read is parsed here, in the engine's own realm, so no page
// hook can observe the argument or the rules the parser builds.
export function parseStyleSheetRules(css: string): ParsedStyleSheetRules {
  ensureInit();
  return ks_parse_stylesheet_structured(css).rules;
}

export function renderHtmlToImage(
  html: string,
  baseUrl: string,
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp",
  quality: number,
): Uint8Array {
  ensureInit();
  return ks_render_html_to_image(html, baseUrl, width, height, format, quality);
}

export function stripFontForShaping(bytes: Uint8Array): Uint8Array | undefined {
  ensureInit();
  return ks_strip_font_for_shaping(bytes);
}

export type { DomHandle };

export interface ParentScriptDescriptor {
  src: string | null;
  kind: "classic" | "module";
  defer: boolean;
  async: boolean;
  body: string;
  prefetchedSource?: string;
  prefetchError?: string;
  resolvedSrc?: string;
  crossOrigin?: string | null;
  integrity?: string | null;
  nonce?: string | null;
  blocked?: { reason: string; message: string };
  injected?: boolean;
  scriptDomIndex?: number;
}

export function extractScriptDescriptorsFromDom(dom: DomHandle | null): ParentScriptDescriptor[] {
  if (!dom) return [];
  let ids: Int32Array | number[];
  try {
    ids = dom.querySelectorAll("script");
  } catch {
    return [];
  }
  const out: ParentScriptDescriptor[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== "number") continue;
    let info: { attributes?: string[] } | null = null;
    try {
      info = dom.nodeInfo(id) as { attributes?: string[] } | null;
    } catch {
      continue;
    }
    const flat = (info && info.attributes) || [];
    const attrs: Record<string, string> = {};
    for (let j = 0; j + 1 < flat.length; j += 2) {
      const k = flat[j];
      const v = flat[j + 1];
      if (typeof k !== "string" || typeof v !== "string") continue;
      attrs[k.toLowerCase()] = v;
    }
    const rawType = (attrs.type || "").trim().toLowerCase();
    if (
      rawType !== "" &&
      rawType !== "text/javascript" &&
      rawType !== "application/javascript" &&
      rawType !== "module"
    ) {
      continue;
    }
    // A browser that runs modules skips a classic script marked nomodule (scan.rs agrees).
    if (rawType !== "module" && "nomodule" in attrs) continue;
    const src = attrs.src ? String(attrs.src).trim() : "";
    let body = "";
    if (!src) {
      try {
        body = dom.textContent(id) ?? "";
      } catch {
        body = "";
      }
    }
    if (!src && (!body || !body.trim())) continue;
    out.push({
      src: src || null,
      kind: rawType === "module" ? "module" : "classic",
      defer: "defer" in attrs,
      async: "async" in attrs,
      body,
      crossOrigin: "crossorigin" in attrs ? String(attrs.crossorigin ?? "") : null,
      integrity: attrs.integrity?.trim() ? attrs.integrity.trim() : null,
      nonce: attrs.nonce ? attrs.nonce : null,
      scriptDomIndex: i,
    });
  }
  return out;
}
