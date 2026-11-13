# Kitesurf on Node.js

An experimental Node.js 24+ host for the existing Kitesurf PageScript, DOM shim,
core Wasm, and scene renderer. It provides a Node API for loading HTML, executing
page JavaScript, and taking screenshots, without starting workerd.

Use it with trusted pages. Node's [`vm` contexts are not a security
sandbox](https://nodejs.org/docs/latest-v24.x/api/vm.html). Worker threads keep page
execution off the caller's event loop and allow timeouts; they do not provide the
isolation guarantees of the Workers backend.

## Try it

From the repository root, with the normal Bazel prerequisites installed:

```sh
pnpm install --frozen-lockfile
bazel run //packages/node:demo -- /tmp/kitesurf-node.png
```

The demo builds the required Wasm and worker bundles, runs an inline page script,
and writes an 800 × 450 PNG. It needs no Cloudflare account or running dev server.

To use the source API directly, first stage the build with `pnpm run build`.
Save this example as `render.mjs` at the repository root, then run `node render.mjs`:

```js
import { writeFile } from "node:fs/promises";
import { createPage } from "./packages/node/src/index.ts";

await using page = await createPage({ width: 800, height: 600 });
await page.setContent(`<!doctype html>
  <h1 id="heading">Hello</h1>
  <script>document.getElementById('heading').textContent += ' from Node';</script>`);

console.log(await page.evaluate(() => document.getElementById("heading").textContent));
await writeFile("page.png", await page.screenshot());
```

Use `setContent(html, { url })` to supply a base URL for relative stylesheets,
scripts, module imports, and fetch requests. HTTP document navigation is outside
this initial API.

## API

| Method                                               | Behavior                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `createPage({ width, height, timeoutMs, debug })`    | Creates a live `about:blank` page. Defaults: 1280 × 720, 30 seconds, quiet logs           |
| `page.setContent(html, { url })`                     | Starts a new document generation; optional URL supplies the document base                 |
| `page.evaluate(expressionOrFunction, { timeoutMs })` | Evaluates page code, awaits promises, and returns PageScript's JSON-serialized value      |
| `page.screenshot()`                                  | Returns PNG bytes with the document background included                                   |
| `page.close()`                                       | Terminates the page worker; safe to call repeatedly. Also available through `await using` |

Evaluation functions are serialized and cannot capture variables from the caller.
A timed-out operation terminates that document's worker and rejects its pending
calls. `setContent` can start a fresh document afterward. Replacing a document
also rejects pending calls on the previous generation. Timeouts must be integers
from 1 through 2,147,483,647 milliseconds.

## Host boundaries

Each document generation owns one Node worker thread. Inside it, separate
`vm.SourceTextModule` contexts load PageScript and the lazy renderer. A small
`cloudflare:workers` module supplies the entrypoint classes. The public API owns
document replacement; `WorkerSession` owns message correlation, deadlines, and
termination. Page calls use the same retained session (`openSession` and `call`)
as Workers, including method-entry hooks and Wasm crash notifications. Startup
inputs and render ports use the shared `@kitesurf/jsrpc-types` contracts.
Render-port data is copied into the receiving context, including Wasm byte buffers.

Import-map parsing, resolution, limits, and CSP checks come from
`@kitesurf/script-gate/import-map`, shared with the Workers host. Each map uses
the base URL captured by the Rust HTML scanner.

PageScript's existing source-based script plan runs page scripts and evaluation
through Boa. This host does not use the Workers engine's navigation-time native
script baking. Runtime code generation stays disabled in the Node VM contexts.

Fonts come from the engine's public assets. Subresources use Node fetch with a
deadline; the renderer obtains resources through its render port and asset
callbacks. The renderer does not receive an outbound network path.

The current host exposes the Node API above. A CDP server, persistent Cookie jar,
browser contexts, dedicated workers, and engine-managed iframe targets are not
implemented here. PageScript, Wasm, and the renderer are shared with the Workers
backend, but this package is not a complete replacement for its engine host.

## Checks

```sh
bazel test //packages/node:test //packages/node:types
pnpm run check
```

The hermetic Node tests use inline markup and a loopback HTTP server. They check
script execution, shared DOM state, concurrent promises and errors, relative
resources, module imports and import maps, meta CSP, custom element upgrades,
undefined results, image pixels, page separation, invalid input, navigation
races, timeout and Wasm crash recovery, and worker shutdown. They start no
workerd processes and make no external network requests.
