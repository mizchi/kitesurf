// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { URL } from "node:url";
import { WorkerSession } from "./session.ts";
import type { ContentOptions, EvaluateOptions, NodePage, PageOptions } from "./contract.ts";
export type { ContentOptions, EvaluateOptions, NodePage, PageOptions } from "./contract.ts";

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function positive(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  return result;
}

class Page implements NodePage {
  private session: WorkerSession | null = null;
  private readonly options: Required<PageOptions>;
  private closed = false;
  private generation = 0;
  private retiring: Promise<void> = Promise.resolve();

  constructor(options: PageOptions) {
    this.options = {
      width: positive(options.width, 1280, "width"),
      height: positive(options.height, 720, "height"),
      timeoutMs: positive(options.timeoutMs, 30_000, "timeoutMs", MAX_TIMEOUT_MS),
      debug: options.debug ?? false,
    };
  }

  async setContent(html: string, options: ContentOptions = {}): Promise<void> {
    this.assertOpen();
    if (typeof html !== "string") throw new TypeError("html must be a string");
    const url = new URL(options.url ?? "about:blank").href;
    const generation = ++this.generation;
    await this.retire(new Error("Page navigation replaced the previous document"));
    this.assertOpen();
    if (generation !== this.generation) throw new Error("Navigation was superseded");
    const session = new WorkerSession({ ...this.options, html, url });
    this.session = session;
    try {
      await session.ready;
    } catch (error) {
      if (this.session === session) this.session = null;
      await session.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async evaluate<T = unknown>(
    expression: string | (() => T | Promise<T>),
    options: EvaluateOptions = {},
  ): Promise<T> {
    const timeoutMs = positive(
      options.timeoutMs,
      this.options.timeoutMs,
      "timeoutMs",
      MAX_TIMEOUT_MS,
    );
    const source = typeof expression === "function" ? `(${expression.toString()})()` : expression;
    return (await this.activeSession().request(
      {
        method: "evaluate",
        expression: source,
        options: { returnByValue: true, awaitPromise: true },
      },
      timeoutMs,
    )) as T;
  }

  async screenshot(): Promise<Uint8Array> {
    const bytes = await this.activeSession().request(
      { method: "screenshot" },
      this.options.timeoutMs,
    );
    if (!(bytes instanceof Uint8Array))
      throw new TypeError("Renderer returned invalid image bytes");
    return bytes;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Page is closed");
  }

  private activeSession(): WorkerSession {
    this.assertOpen();
    if (!this.session)
      throw new Error("Page has no live document; call setContent() to replace it");
    return this.session;
  }

  private async retire(reason: Error): Promise<void> {
    const session = this.session;
    this.session = null;
    this.retiring = Promise.all([this.retiring, session?.close(reason)]).then(() => {});
    await this.retiring;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    await this.retire(new Error("Page is closed"));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function createPage(options: PageOptions = {}): Promise<NodePage> {
  const page = new Page(options);
  try {
    await page.setContent("");
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}
