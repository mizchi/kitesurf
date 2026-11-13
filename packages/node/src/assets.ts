// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

export function readAsset(path: string): Promise<Buffer> {
  return readFile(resolve(root, path));
}

export async function readFont(path: string): Promise<Uint8Array> {
  const fonts = resolve(root, "packages/engine/public/fonts");
  const file = resolve(fonts, path.replace(/^\/fonts\//, ""));
  if (!file.startsWith(fonts + sep)) throw new Error("Font path is outside the asset directory");
  return readFile(file);
}

export function pageFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "http://kitesurf-fonts") {
      return new Response(await readFont(url.pathname));
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    return fetch(request, { signal });
  };
}
