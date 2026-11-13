// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds document script policy and gates import maps and scripts before fetch.

import {
  buildScriptGateContext,
  checkScriptBeforeFetch,
  scriptGateIsNoop,
  type ScriptGateContext,
} from "@kitesurf/script-gate";
export {
  applyImportMapGate,
  documentBaseUrl,
  type GatedImportMap,
} from "@kitesurf/script-gate/import-map";
import type { DocScan, ParentScriptDescriptor } from "../wasm.ts";

export type { ScriptGateContext };

export interface DocumentPolicySources {
  csp?: string | null;
  cspReportOnly?: string | null;
  scan?: DocScan | null;
}

export function documentGateContext(
  documentUrl: string,
  sources: DocumentPolicySources,
): ScriptGateContext {
  return buildScriptGateContext(documentUrl, {
    cspHeaders: [sources.csp],
    cspReportOnlyHeaders: [sources.cspReportOnly],
    metaCsp: sources.scan?.metaCsp ?? [],
  });
}

export function resolveScriptUrl(src: string, baseUrl: string): string | null {
  if (!src) return null;
  try {
    return baseUrl ? new URL(src, baseUrl).toString() : new URL(src).toString();
  } catch {
    return null;
  }
}

export async function applyPreFetchScriptGate(
  descriptors: readonly ParentScriptDescriptor[],
  gate: ScriptGateContext,
  baseUrl: string,
): Promise<ParentScriptDescriptor[]> {
  const out = descriptors.map((d) => ({ ...d }));
  if (scriptGateIsNoop(gate)) return out;

  await Promise.all(
    out.map(async (d) => {
      if (d.injected === true) return;
      const url = d.src ? resolveScriptUrl(d.src, baseUrl) : null;
      if (d.src && url === null) return;
      const decision = await checkScriptBeforeFetch(gate, {
        url,
        integrity: d.integrity ?? null,
        nonce: d.nonce ?? null,
        body: d.src ? "" : (d.body ?? ""),
        runtimeInserted: false,
        module: d.kind === "module",
      });
      if (decision.reportOnly) {
        console.warn(`[kitesurf-csp] ${decision.reportOnly}`);
      }
      if (!decision.allowed) {
        d.blocked = {
          reason: decision.reason ?? "csp",
          message: decision.message ?? "blocked by policy",
        };
        return;
      }
      if (decision.upgradeTo) d.resolvedSrc = decision.upgradeTo;
    }),
  );
  return out;
}
