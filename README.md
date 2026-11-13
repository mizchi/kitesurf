![Kitesurf logo](.github/assets/kitesurf_logo.png)

# Kitesurf

Kitesurf is an experimental browser engine that runs on Cloudflare Workers. It
parses HTML, applies CSS, runs page JavaScript, and renders screenshots without
Chrome or a browser container.

Kitesurf speaks the [Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/),
so you can use it with CDP clients such as Puppeteer.

> [!IMPORTANT]
> The Workers backend requires Cloudflare Dynamic Workers to create isolated workers for
> pages. Dynamic Workers are part of the [Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/).
> Local development uses `wrangler dev`. A Cloudflare Workers Paid plan is
> required to run Kitesurf on Cloudflare.

## Requirements

- [Bazelisk](https://github.com/bazelbuild/bazelisk), installed as `bazel`.
  Bazel builds everything. It downloads the pinned Bazel, Rust toolchains,
  wasm-bindgen, and binaryen itself.
- Node.js 22 or newer
- pnpm 9.15.4, which the repository pins in `package.json`
- On macOS, GNU tar (`brew install gnu-tar`)
- Rust through [rustup](https://rustup.rs/), only for editing the vendored
  crate patches. `rust-toolchain.toml` pins the same nightly that Bazel uses.

Install pnpm separately if it is not already available:

```bash
npm install --global pnpm@9.15.4
```

## Build and run locally

Clone the repository and install its dependencies:

```bash
git clone https://github.com/cloudflare/kitesurf.git
cd kitesurf
pnpm install --frozen-lockfile
```

Build and start the local engine:

```bash
pnpm run dev
```

The engine listens on `http://127.0.0.1:8787`. Visit
`http://127.0.0.1:8787/health` to confirm that it is running.

The root URL shows the landing page. It has a form to open a URL in Chrome
DevTools, example pages, and the CDP endpoints for agents and other clients.
See [Use Chrome DevTools](#use-chrome-devtools).

`pnpm run dev` builds the WebAssembly modules and the page and renderer bundles
with Bazel, then starts `wrangler dev`. The first build compiles the Rust core
and its vendored crates, which takes a while; later builds reuse Bazel's cache.

Set `KITESURF_PORT` when port `8787` is already in use:

```bash
KITESURF_PORT=8799 pnpm run dev
```

## Run on Node.js (experimental)

For an experimental Node.js API that runs page JavaScript and takes screenshots
without starting workerd, see [Kitesurf on Node.js](packages/node/README.md).
The Node host currently exposes its own API rather than a CDP server.

## Connect with Puppeteer

Install `puppeteer-core` in the project that will control Kitesurf. Then connect
to the browser WebSocket endpoint:

```js
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://127.0.0.1:8787/devtools/browser",
});

const page = await browser.newPage();
await page.goto("https://example.com/");
await page.screenshot({ path: "page.png" });

await browser.disconnect();
```

Use the port from `KITESURF_PORT` if you selected a different port. HTTP
discovery is available at `http://127.0.0.1:8787/json/version`.

## Use Chrome DevTools

With `pnpm run dev`, open `http://127.0.0.1:8787/` in Chrome. Enter a URL to
inspect, or select one of the example pages. DevTools opens in the tab on that
page. To go to DevTools directly, open
`http://127.0.0.1:8787/?url=https://example.com`, or
`http://127.0.0.1:8787/?inspect=1` for a blank page.

If you built the bundled frontend, `pnpm run dev` serves it from the engine's
own origin. See
[Use the bundled DevTools frontend](#use-the-bundled-devtools-frontend).
Otherwise, the DevTools frontend comes from
`chrome-devtools-frontend.appspot.com`, the build that Google hosts for Chrome.
The hosted frontend has these limits:

- The first time it connects, Chrome asks whether
  `chrome-devtools-frontend.appspot.com` can access apps on this device. Select
  **Allow**.
- If you block this access, DevTools says that the WebSocket disconnected. To
  allow it again, click the site information icon to the left of the address.
  Then allow the access and reconnect DevTools.
- The frontend can connect only to `127.0.0.1`. Thus it does not work with a
  deployed engine.

You can also use `chrome://inspect`:

1. Open `chrome://inspect/#devices` in Chrome. Type or paste it into the address
   bar because web pages cannot link to it.
2. Select **Discover network targets**.
3. Select **Configure...** and add `127.0.0.1:8787`.
4. Under **Remote Target**, select **inspect** next to **kitesurf**.
5. Enter a page URL in the address bar above the screencast.

Use the port from `KITESURF_PORT` when you select a different local port. Chrome
discovers targets with plain HTTP and WebSocket connections. The `chrome://inspect`
workflow cannot reach an HTTPS engine. Use it with a local engine instead.

Kitesurf provides a CDP endpoint, not a full Chrome implementation. Some Chrome
DevTools features do not work yet. We are working to add more support over time.
Puppeteer and other CDP clients can connect to
`ws://127.0.0.1:8787/devtools/browser`.

### Use the bundled DevTools frontend

Kitesurf can serve the Chrome DevTools frontend from its own origin. Then
DevTools works without the hosted frontend, its permission prompt and the
`127.0.0.1` limit. A deployed engine always uses this copy. The frontend is the
prebuilt build that Google publishes for Chromium. The default build does not
include it.

#### Build the frontend

The `--config=devtools` Bazel option adds the frontend to the build. The first
build with it downloads the frontend (about 250 MB). Bazel keeps the download
in its cache for later builds.

To build the frontend once, run this command from the repository root:

```bash
bazel run --config=devtools //packages/engine:dev_build
```

To include the frontend in every local build, add the option to
`.bazelrc.user`. Git ignores this file. Then `pnpm run build` and
`pnpm run dev` include the frontend.

```bash
echo 'common --config=devtools' >> .bazelrc.user
```

The build copies the frontend to `packages/engine/public/inspector/`. Git
ignores this directory. A build without the option removes it. To turn the
frontend off, remove the line from `.bazelrc.user`.

#### Run the frontend locally

1. Build the frontend as described above.
2. Start the engine with `pnpm run dev`. The engine serves the bundled frontend
   when the build includes it, and the hosted frontend when it does not.
3. Open `http://127.0.0.1:8787/` in Chrome. Enter a URL to inspect, or select
   one of the example pages. DevTools opens in the tab on that page.

To start on a page, open `http://127.0.0.1:8787/?url=https://example.com`.

#### Rebuild the frontend

Use the smallest step that fixes the problem:

- To copy the frontend files again, delete the copy and build again:

  ```bash
  rm -rf packages/engine/public/inspector
  bazel run --config=devtools //packages/engine:dev_build
  ```

- To extract the archive again, for example after you change
  `bazel/devtools_frontend.BUILD`, fetch it again and then build:

  ```bash
  bazel fetch --force --repo=@devtools_frontend --config=devtools
  bazel run --config=devtools //packages/engine:dev_build
  ```

  Bazel extracts the archive from its cache. To download the archive again
  from Google, add `--repository_cache=` to the `bazel fetch` command.

Do not use `bazel clean --expunge` for this. It also removes the WebAssembly
build and the rest of the Bazel cache.

#### Update the frontend version

Two pins select the frontend version:

- `DEVTOOLS_FRONTEND_REV` and the values after it in `MODULE.bazel` select the
  bundled frontend. The comment above them tells you how to select a new
  snapshot.
- `KITESURF_INSPECTOR_FALLBACK_URL` in the `local` environment of
  `packages/engine/wrangler.jsonc` selects the hosted frontend. Use the
  Chrome commit that
  `https://chromiumdash.appspot.com/fetch_version?version=<chrome-version>`
  returns in `hashes.chromium`.

Keep the two pins on the same Chrome version. After you change
`MODULE.bazel`, the next build downloads the new archive.

## Build and test

The pnpm scripts are front ends to Bazel:

```bash
pnpm run build                    # bazel run //packages/engine:dev_build
pnpm run check                    # type checks, bundles, and repository checks
pnpm run test:unit                # engine vitest and Rust host tests
pnpm run test:e2e <file-substring>
pnpm run format:check             # oxfmt; pnpm run format rewrites the same files
pnpm run format:rust              # format Rust with Bazel's pinned rustfmt
pnpm run lint                     # oxlint, the custom lint rules, and Rust lint
```

The Rust formatter rewrites tracked and non-ignored untracked files, excluding
paths in `.oxfmtrc.json`.

`pnpm run build` copies the Bazel-built WebAssembly, bundles, and RBI files into
the source tree, where `wrangler dev` reads them. Other targets run directly,
for example `bazel test //tests/e2e:gate` for the full e2e suite. Another Bazel
workspace can depend on this repository as a module.

## Technology stack

Kitesurf combines several open-source Rust projects:

- [Blitz](https://github.com/DioxusLabs/blitz) provides HTML parsing, the DOM,
  layout, and painting. It is licensed under `MIT OR Apache-2.0`.
- [Stylo](https://github.com/servo/stylo) provides CSS parsing, cascading, and
  computed styles. It is licensed under `MPL-2.0`.
- [Boa](https://github.com/boa-dev/boa) runs page JavaScript inside WebAssembly.
  It is licensed under `Unlicense OR MIT`.
- [Linebender](https://linebender.org/) libraries provide text layout and 2D
  graphics, including [Parley](https://github.com/linebender/parley),
  [Vello](https://github.com/linebender/vello),
  [Kurbo](https://github.com/linebender/kurbo), and
  [Peniko](https://github.com/linebender/peniko). These libraries are licensed
  under `Apache-2.0 OR MIT`.
- [Krilla](https://github.com/LaurenzV/krilla) generates PDF output. It is
  licensed under `MIT OR Apache-2.0`.

Kitesurf patches its Rust dependencies. The patch series are in
[`scripts/patches/`](scripts/patches/), and Bazel applies them itself.

## Cloudflare deployment

> [!WARNING]
> Do not deploy Kitesurf without authentication in front of it. Use
> [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev)
> (Cloudflare Zero Trust) or another authentication layer. The engine has no
> authentication of its own. A person who has the URL can:
>
> - Open DevTools and browse the web through your engine.
> - Connect Puppeteer and other CDP clients to it.
> - Send outbound requests that come from your Cloudflare account.
> - Use CPU time and Dynamic Workers that your account pays for.
>
> The `workers.dev` URL is public by default. Its name follows a predictable
> pattern: `kitesurf.<your-subdomain>.workers.dev`.

To deploy the engine as a Worker on your Cloudflare account:

1. Deploy the engine. Run the command from the repository root. In a package
   directory, use `pnpm -w run deploy`.

   ```bash
   pnpm run deploy
   ```

2. Protect the Worker URL with Cloudflare Access immediately. Follow
   [Manage access to `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev).
   For a custom domain or route, protect it with a
   [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/).
3. Open the Worker URL in Chrome. Access asks you to sign in. Then the landing
   page opens. Enter a URL to open it in DevTools.

Between steps 1 and 2, the engine is public. To prevent this gap, turn on Access
for all Workers in the account before you deploy. The `workers.dev` page in
step 2 tells you how.

The command builds the engine with Bazel and uploads it with Wrangler. Wrangler
uses the account of `wrangler login`, or `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. The command sends other arguments to `wrangler deploy`,
for example `--name <worker-name>`. Without `--name`, the Worker name is
`kitesurf`.

To build the deploy without an upload, run `pnpm run deploy --dry-run`.

To upload a version without sending traffic to it, run `pnpm run deploy:preview`.
The command runs `wrangler versions upload`. If the Worker has Version URLs
turned on, Wrangler prints the URL of the new version. Version URLs are public
too. Protect them with Access as well. Follow
[Manage access to Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/#manage-access-to-version-urls).

The deploy always builds with `--config=devtools`, so it includes the Chrome
DevTools frontend. You do not need `.bazelrc.user` for it. The first deploy
downloads the frontend, as the first local build does. The deploy sets
`KITESURF_INSPECTOR_BASE_URL` to `/inspector/inspector.html`. To use a different
frontend, add `--var KITESURF_INSPECTOR_BASE_URL:<url>` to the command.

DevTools loads from the Worker's own origin, so its WebSocket sends the Access
cookie. A DevTools frontend on another origin cannot connect through Access.

### Connect a CDP client through Access

Access blocks a CDP client that has no browser session. To connect Puppeteer:

1. Create an
   [Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
2. Add a policy with the **Service Auth** action that allows this token.
3. Send the token headers with the WebSocket connection:

   ```js
   const browser = await puppeteer.connect({
     browserWSEndpoint: "wss://<worker-host>/devtools/browser",
     headers: {
       "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
       "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
     },
   });
   ```

Keep the service token secret. The token gives the same access as a signed-in
user.

The engine configuration includes a Worker Loader binding. Kitesurf uses this
binding to start a separate worker for each page and renderer. Cloudflare
Dynamic Workers provide this capability, and they require the Workers Paid plan.
See the [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
documentation before planning a Cloudflare deployment.

## Packages

| Package                                        | Description                                    |
| ---------------------------------------------- | ---------------------------------------------- |
| [`engine`](packages/engine/)                   | Cloudflare Worker and CDP server               |
| [`page-script`](packages/page-script/)         | Page DOM and JavaScript runtime                |
| [`page-renderer`](packages/page-renderer/)     | Renderer for recorded page scenes              |
| [`dom-shim`](packages/dom-shim/)               | DOM APIs inside the page worker                |
| [`core`](packages/core/)                       | Rust layout, paint, and JavaScript engine code |
| [`renderer-core`](packages/renderer-core/)     | Rust scene rasterizer for page rendering       |
| [`scene-host-wasm`](packages/scene-host-wasm/) | Local scene rasterizer for the terminal client |
| [`kitesurf-cli`](packages/kitesurf-cli/)       | Terminal client                                |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.
Report security problems as described in [SECURITY.md](SECURITY.md).

## License

Kitesurf is licensed under [Apache 2.0](LICENSE). Bundled fonts, data, and
dependencies keep their own licenses. See [NOTICE](NOTICE).
