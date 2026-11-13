// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPage } from "../src/index.ts";

await using page = await createPage({ width: 800, height: 450 });
await page.setContent(`<!doctype html><title>Kitesurf on Node.js</title>
<style>
  body { margin: 0; background: #102438; color: white; font-family: sans-serif;
    display: flex; align-items: center; justify-content: center; height: 100vh; }
  main { padding: 36px; border-left: 6px solid #ff8a3d; }
  h1 { margin: 0 0 12px; font-size: 44px; } p { margin: 0; font-size: 20px; }
</style>
<main><h1>Kitesurf on Node.js</h1><p id="status">Loading...</p></main>
<script>document.getElementById('status').textContent = 'DOM, JavaScript and Rust/Wasm rendering';</script>`);
const output = resolve(
  process.env.BUILD_WORKING_DIRECTORY ?? process.cwd(),
  process.argv[2] ?? "kitesurf-node.png",
);
await writeFile(output, await page.screenshot());
console.log(await page.evaluate("document.title"));
console.log(output);
