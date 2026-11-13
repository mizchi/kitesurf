// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Worker } from "node:worker_threads";
import { URL } from "node:url";
import type { Command, Operation, PageInit, Reply } from "./contract.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class WorkerSession {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private failure: Error | null = null;
  private termination: Promise<number> | null = null;

  constructor(input: PageInit) {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      execArgv: ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning"],
      workerData: input,
    });
    this.ready = this.waitFor(0, input.timeoutMs).then(() => {});
    this.worker.on("message", (reply: Reply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else {
        const error = new Error(reply.error.message);
        if (reply.error.stack) error.stack = reply.error.stack;
        pending.reject(error);
      }
    });
    this.worker.on("error", (error: Error) => {
      void this.close(error);
    });
    this.worker.on("exit", (code) => {
      void this.close(new Error(`Page worker exited (${code})`));
    });
  }

  async request(operation: Operation, timeoutMs: number): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    const result = this.waitFor(id, timeoutMs);
    try {
      this.worker.postMessage({ ...operation, id } satisfies Command);
    } catch (error) {
      const pending = this.pending.get(id)!;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }

  private waitFor(id: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.close(new Error(`Page operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async close(reason: Error): Promise<void> {
    if (!this.termination) {
      this.failure = reason;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(reason);
      }
      this.pending.clear();
      this.termination = this.worker.terminate();
    }
    await this.termination;
  }
}
