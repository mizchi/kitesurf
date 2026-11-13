// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { parentPort, workerData } from "node:worker_threads";
import type { PageScriptEntrypoint } from "@kitesurf/jsrpc-types/page-script";
import type { PageRendererRpc, RenderPort } from "@kitesurf/jsrpc-types/page-renderer";
import { pageFetch, readAsset, readFont } from "./assets.ts";
import { Realm } from "./realm.ts";
import type { Command, PageInit, Reply } from "./contract.ts";

const port = parentPort;
if (!port) throw new Error("Kitesurf page worker requires a parent port");
const input: PageInit = workerData;

const startup = {
  html: input.html,
  url: input.url,
  cookies: "",
  scriptDescriptors: [],
  userAgent: "Kitesurf/Node",
  referrer: "",
  referrerPolicy: "",
  hasClassicRegular: false,
  hasClassicAsync: false,
  moduleScriptCount: 0,
  resourceDrainQuietTurns: 2,
  pixelFree: false,
  fontDefer: false,
  moduleScriptUrls: [],
  jsonModuleUrls: [],
  cdpDebug: false,
  lagWatchdog: false,
  csp: [],
  metaCsp: [],
  insertedBaked: [],
};

const importMap = `
export function resolveImportMap(specifier, importer) { return new URL(String(specifier), importer).href; }
export function resolveModuleRegistryUrl(url) {
  if (!/^https?:/.test(String(url))) throw new TypeError('Only HTTP(S) page modules are allowed');
  return String(url);
}
`;

async function createRuntime(): Promise<(command: Command) => Promise<unknown>> {
  const [pageSource, shim, internalState, glue, wasm] = await Promise.all([
    readAsset("packages/page-script/dist/page-script.js"),
    readAsset("packages/dom-shim/dist/dom-shim.js"),
    readAsset("packages/page-script/dist/internal-state.js"),
    readAsset("packages/core/pkg/kitesurf_core.glue.js"),
    readAsset("packages/core/pkg/kitesurf_core_bg.wasm"),
  ]);
  const pageRealm = new Realm(
    {
      "page.js": pageSource.toString(),
      "dom-shim.js": shim.toString(),
      "internal-state.js": internalState.toString(),
      "wasm-glue.js": glue.toString(),
      "__ks_startup_probe_input.js": { exports: startup },
      "__ks_import_map.js": importMap,
      "__ks_wasm_registry.js":
        'import emptyModule from "./__ks_empty.wasm"; export { emptyModule }; export const bakedWasm = {}; export const manifest = {};',
    },
    pageFetch(input.timeoutMs),
    input.debug,
  );
  pageRealm.addWasm("core_bg.wasm", wasm);
  pageRealm.addWasm("__ks_empty.wasm", Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const module = await pageRealm.load("page.js");
  const Page = module.PageScript as new (ctx: unknown, env: unknown) => PageScriptEntrypoint;
  const ctx = {
    props: {},
    waitUntil(promise: Promise<unknown>) {
      void promise.catch((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
    },
  };
  const page = new Page(ctx, {});
  const core = await pageRealm.load("wasm-glue.js");
  const scanDocument = core.ks_scan_document;
  if (typeof scanDocument !== "function")
    throw new Error("Core Wasm does not export the HTML scanner");
  const scan: unknown = JSON.parse(scanDocument(input.html));
  const metaCsp =
    typeof scan === "object" && scan !== null && "metaCsp" in scan && Array.isArray(scan.metaCsp)
      ? scan.metaCsp.filter((value): value is string => typeof value === "string")
      : [];
  const navigate = await page.navigate(input.html, input.url, {
    scriptPolicy: {
      cspHeaders: [],
      cspReportOnlyHeaders: [],
      metaCsp,
    },
    viewportWidth: input.width,
    viewportHeight: input.height,
  });
  const loaded = await page.awaitLoad();
  const exceptions = [...(navigate.exceptions ?? []), ...(loaded.exceptions ?? [])];
  if (exceptions.length) throw new Error(exceptions.map((error) => error.message).join("\n"));
  let renderer: { realm: Realm; rpc: PageRendererRpc } | null = null;

  return async (command: Command): Promise<unknown> => {
    if (command.method === "evaluate") {
      const result = await page.evaluate(command.expression, command.options);
      if (!result.ok) throw new Error(result.exception.message);
      if (result.serializationError) throw new Error(result.serializationError);
      return result.valueJson === undefined ? undefined : JSON.parse(result.valueJson);
    }
    if (!renderer) {
      const [source, glue, wasm] = await Promise.all([
        readAsset("packages/page-renderer/dist/page-renderer.js"),
        readAsset("packages/renderer-core/pkg/renderer_core.glue.js"),
        readAsset("packages/renderer-core/pkg/renderer_core_bg.wasm"),
      ]);
      const realm = new Realm(
        { "renderer.js": source.toString(), "wasm-glue.js": glue.toString() },
        async () => {
          throw new Error("Renderer has no outbound network path");
        },
        input.debug,
      );
      realm.addWasm("core_bg.wasm", wasm);
      const module = await realm.load("renderer.js");
      const Renderer = module.PageRenderer as new (ctx: unknown, env: unknown) => PageRendererRpc;
      renderer = { realm, rpc: new Renderer(ctx, {}) };
    }
    const { realm, rpc } = renderer;
    const source = page.makeRenderPort();
    const renderPort: RenderPort = {
      recordScene: async (args) =>
        realm.importValue(await source.recordScene(pageRealm.importValue(args))),
      getPaintResources: async (args) =>
        realm.importValue(await source.getPaintResources(pageRealm.importValue(args))),
      getFontUrlData: async (args) =>
        realm.importValue(await source.getFontUrlData(pageRealm.importValue(args))),
      recordPdfScenes: async (args) =>
        realm.importValue(await source.recordPdfScenes(pageRealm.importValue(args))),
    };
    const result = await rpc.renderFrame(
      renderPort,
      { format: "png", quality: 80, omitBackground: false },
      async (path) => realm.importValue(await readFont(path)),
    );
    if (result.error || !result.bytes)
      throw new Error(result.error ?? "Renderer returned no image");
    return result.bytes;
  };
}

function fail(id: number, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  port!.postMessage({
    id,
    ok: false,
    error: { message: err.message, stack: err.stack },
  } satisfies Reply);
}

try {
  const dispatch = await createRuntime();
  let queue = Promise.resolve();
  port.on("message", (command: Command) => {
    queue = queue.then(async () => {
      try {
        port.postMessage({
          id: command.id,
          ok: true,
          value: await dispatch(command),
        } satisfies Reply);
      } catch (error) {
        fail(command.id, error);
      }
    });
  });
  port.postMessage({ id: 0, ok: true, value: undefined } satisfies Reply);
} catch (error) {
  fail(0, error);
}
