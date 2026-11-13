// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { createContext, runInContext, SourceTextModule, SyntheticModule } from "node:vm";
import type { Context, Module } from "node:vm";

type ModuleInput = string | { exports: Record<string, unknown> };

const workerModule = `
export class WorkerEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class RpcTarget {}
export function abortIsolate(reason) { throw new Error(String(reason ?? 'isolate aborted')); }
`;

export class Realm {
  readonly context: Context;
  private readonly modules = new Map<string, Module>();
  private readonly sources: Map<string, ModuleInput>;
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private nextTimer = 0;
  private readonly copy: (value: unknown) => unknown;

  constructor(sources: Record<string, ModuleInput>, network: typeof fetch, debug: boolean) {
    this.sources = new Map(Object.entries(sources));
    this.sources.set("cloudflare:workers", workerModule);
    const quiet = () => {};
    const consoleMethods = Object.fromEntries(
      Object.entries(console).map(([name, value]) => [
        name,
        typeof value === "function" ? (debug ? value.bind(console) : quiet) : value,
      ]),
    );
    this.context = createContext(
      {
        console: consoleMethods,
        fetch: network,
        Request,
        Response,
        Headers,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        AbortController,
        AbortSignal,
        DOMException,
        Event,
        EventTarget,
        MessageEvent,
        Blob,
        File,
        FormData,
        ReadableStream,
        WritableStream,
        TransformStream,
        ByteLengthQueuingStrategy,
        CountQueuingStrategy,
        CompressionStream,
        DecompressionStream,
        crypto,
        performance,
        atob,
        btoa,
        structuredClone,
        queueMicrotask,
        setTimeout: (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
          const id = ++this.nextTimer;
          this.timers.set(
            id,
            setTimeout(() => {
              this.timers.delete(id);
              fn(...args);
            }, ms),
          );
          return id;
        },
        clearTimeout: (id: number) => {
          clearTimeout(this.timers.get(id));
          this.timers.delete(id);
        },
        setInterval: (fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
          const id = ++this.nextTimer;
          this.timers.set(id, setInterval(fn, ms, ...args));
          return id;
        },
        clearInterval: (id: number) => {
          clearInterval(this.timers.get(id));
          this.timers.delete(id);
        },
      },
      { name: "Kitesurf", codeGeneration: { strings: false, wasm: true } },
    );
    // Cloudflare RPC copies data into the recipient realm; local render-port calls need the same.
    this.copy = runInContext(
      `(function copy(value) {
      if (value === null || typeof value !== 'object') return value;
      if (ArrayBuffer.isView(value)) return new Uint8Array(value);
      if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
        return new Uint8Array(new Uint8Array(value)).buffer;
      }
      if (Array.isArray(value)) return Array.from(value, copy);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    })`,
      this.context,
    );
  }

  importValue<T>(value: T): T {
    return this.copy(value) as T;
  }

  addWasm(name: string, bytes: Uint8Array): void {
    this.context.__wasmBytes = bytes;
    try {
      const module = runInContext(
        "new WebAssembly.Module(new Uint8Array(__wasmBytes))",
        this.context,
      );
      this.sources.set(name, { exports: { default: module } });
    } finally {
      delete this.context.__wasmBytes;
    }
  }

  async load(name: string): Promise<Record<string, unknown>> {
    const module = this.module(name);
    if (module.status === "unlinked") await module.link((specifier) => this.module(specifier));
    await module.evaluate();
    return Object.fromEntries(Object.entries(module.namespace));
  }

  private module(specifier: string): Module {
    const name = specifier.startsWith("./") ? specifier.slice(2) : specifier;
    const cached = this.modules.get(name);
    if (cached) return cached;
    const source = this.sources.get(name);
    if (source === undefined) throw new Error(`Module is not in the page registry: ${specifier}`);
    const module =
      typeof source === "string"
        ? new SourceTextModule(source, {
            context: this.context,
            identifier: name,
            initializeImportMeta: (meta) => {
              meta.url = name;
            },
            importModuleDynamically: async (specifier) => {
              await this.load(specifier);
              return this.module(specifier);
            },
          })
        : new SyntheticModule(
            Object.keys(source.exports),
            function () {
              for (const [key, value] of Object.entries(source.exports)) this.setExport(key, value);
            },
            { context: this.context, identifier: name },
          );
    this.modules.set(name, module);
    return module;
  }
}
