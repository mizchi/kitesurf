// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PNG } from "pngjs";
import { createPage } from "../src/index.ts";

test("Node runs page scripts and Boa against the same DOM", async () => {
  await using page = await createPage({ width: 120, height: 80 });
  assert.equal(await page.evaluate("document.URL"), "about:blank");
  await page.setContent(`<!doctype html><title>Node page</title>
    <main id="value">before</main><script>
    document.getElementById('value').textContent = 'inline script';
    window.counter = 40;
    </script>`);
  assert.equal(await page.evaluate(() => document.title), "Node page");
  assert.equal(
    await page.evaluate("document.getElementById('value').textContent"),
    "inline script",
  );
  assert.equal(await page.evaluate("++window.counter"), 41);
  assert.equal(await page.evaluate("Promise.resolve(window.counter + 1)"), 42);
  await assert.rejects(page.evaluate("throw new Error('page failure')"), /page failure/);
  assert.equal(await page.evaluate("typeof process"), "undefined");
});

test("Node loads relative resources and renders changed pixels", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("html,body{margin:0;width:100%;height:100%;background:#ff0000}");
    } else if (req.url === "/page.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("document.title = 'external script';");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await using page = await createPage({ width: 32, height: 24 });
  await page.setContent(
    '<!doctype html><link rel="stylesheet" href="/style.css"><script src="/page.js"></script>',
    { url: `${url}/page` },
  );
  assert.equal(await page.evaluate("document.URL"), `${url}/page`);
  assert.equal(await page.evaluate("document.title"), "external script");
  const before = PNG.sync.read(Buffer.from(await page.screenshot()));
  assert.equal(before.width, 32);
  assert.equal(before.height, 24);
  assert.deepEqual([...before.data.subarray(0, 4)], [255, 0, 0, 255]);
  await page.evaluate("document.body.style.backgroundColor = '#00ff00'");
  const after = PNG.sync.read(Buffer.from(await page.screenshot()));
  assert.deepEqual([...after.data.subarray(0, 4)], [0, 255, 0, 255]);
});

test("pages and navigation generations keep their globals separate", async () => {
  await using first = await createPage();
  await using second = await createPage();
  await first.setContent("<title>first</title>");
  await first.evaluate("window.onlyHere = 42");
  assert.equal(await second.evaluate("typeof window.onlyHere"), "undefined");
  await first.setContent("<title>next</title>");
  assert.equal(await first.evaluate("typeof window.onlyHere"), "undefined");
  assert.equal(await second.evaluate("document.title"), "");
  await first.close();
  await first.close();
  await assert.rejects(first.evaluate("1"), /closed/);
});

test("a timed-out evaluation terminates its worker and can be replaced", async () => {
  await using page = await createPage();
  await assert.rejects(page.evaluate("for (;;) {}", { timeoutMs: 50 }), /timed out/);
  await page.setContent("<title>recovered</title>");
  assert.equal(await page.evaluate("document.title"), "recovered");
});

test("module imports and fetch use the document origin", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/dep.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("export const answer = 42;");
    } else if (req.url === "/data.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"answer":43}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await using page = await createPage();
  await page.setContent(
    `<script type="module">
    import { answer } from './dep.js'; document.title = String(answer);
  </script>`,
    { url: `http://127.0.0.1:${server.address().port}/` },
  );
  assert.equal(await page.evaluate("document.title"), "42");
  assert.equal(
    await page.evaluate("fetch('/data.json').then(r => r.json()).then(data => data.answer)"),
    43,
  );
});

test("closing during navigation cannot start another worker", async () => {
  const page = await createPage();
  try {
    const navigation = page.setContent("<title>late</title>");
    const closing = page.close();
    await assert.rejects(navigation, /closed|superseded/);
    await closing;
  } finally {
    await page.close();
  }
});

test("a newer navigation retires an older in-flight generation", async () => {
  await using page = await createPage();
  const old = page.setContent("<title>old</title>");
  const current = page.setContent("<title>current</title>");
  await assert.rejects(old, /superseded|replaced/);
  await current;
  assert.equal(await page.evaluate("document.title"), "current");
});

test("the Node host passes document script policies to PageScript", async () => {
  await using page = await createPage();
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
    <title>unchanged</title><script>document.title = 'ran';</script>`);
  assert.equal(await page.evaluate("document.title"), "unchanged");
});

test("image resources cross into the renderer realm", async () => {
  const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([18, 52, 86, 255]) });
  await using page = await createPage({ width: 2, height: 2 });
  await page.setContent(`<style>body{margin:0}</style>
    <img style="display:block" width="1" height="1" src="data:image/png;base64,${png.toString("base64")}">`);
  const image = PNG.sync.read(Buffer.from(await page.screenshot()));
  assert.deepEqual([...image.data.subarray(0, 4)], [18, 52, 86, 255]);
});

test("invalid content leaves the current document usable", async () => {
  await using page = await createPage();
  await page.setContent("<title>still here</title>");
  await assert.rejects(page.setContent(null), /html must be a string/);
  await assert.rejects(page.setContent("replacement", { url: "://" }), /Invalid URL/);
  await assert.rejects(page.evaluate("42", { timeoutMs: 2 ** 31 }), /timeoutMs.*2147483647/);
  assert.equal(await page.evaluate("document.title"), "still here");
});

test("timeouts outside Node's timer range are rejected before starting a worker", async () => {
  await assert.rejects(createPage({ timeoutMs: 2 ** 31 }), /timeoutMs.*2147483647/);
});

test("concurrent evaluations settle independently after a page error", async () => {
  await using page = await createPage();
  const results = await Promise.allSettled([
    page.evaluate("21 * 2"),
    page.evaluate("throw new Error('only this call fails')"),
    page.evaluate("6 * 7"),
  ]);
  assert.equal(results[0].value, 42);
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /only this call fails/);
  assert.equal(results[2].value, 42);
  assert.equal(await page.evaluate("1 + 1"), 2);
});

test("closing rejects all pending evaluations", async () => {
  const page = await createPage();
  try {
    const pending = Promise.allSettled([
      page.evaluate("new Promise(() => {})"),
      page.evaluate("42"),
    ]);
    await Promise.all([page.close(), page.close()]);
    const results = await pending;
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /closed/);
    }
  } finally {
    await page.close();
  }
});

test("a timed-out document initialization can be replaced", async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await using page = await createPage({ timeoutMs: 2_000 });
  await assert.rejects(
    page.setContent(`<script src="http://127.0.0.1:${server.address().port}/never.js"></script>`),
    /timed out/,
  );
  await page.setContent("<title>replacement</title>");
  assert.equal(await page.evaluate("document.title"), "replacement");
  assert.ok((await page.screenshot()).length > 0);
});
