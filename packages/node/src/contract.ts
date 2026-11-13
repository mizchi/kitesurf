// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { EvalOptions } from "@kitesurf/jsrpc-types/page-script";

export interface PageOptions {
  width?: number;
  height?: number;
  timeoutMs?: number;
  debug?: boolean;
}

export interface ContentOptions {
  url?: string;
}

export interface EvaluateOptions {
  timeoutMs?: number;
}

export interface NodePage extends AsyncDisposable {
  setContent(html: string, options?: ContentOptions): Promise<void>;
  evaluate<T = unknown>(
    expression: string | (() => T | Promise<T>),
    options?: EvaluateOptions,
  ): Promise<T>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PageInit extends Required<PageOptions> {
  html: string;
  url: string;
}

export type Operation =
  | { method: "evaluate"; expression: string; options: EvalOptions }
  | { method: "screenshot" };

export type Command = Operation & { id: number };

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; stack?: string } };
