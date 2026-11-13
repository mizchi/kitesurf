// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// @ks-declaration-twin for the synthetic sibling generated per navigation.
// External bodies ride the classic bundle; descriptors retain their byte length.

import type { PageScriptBootstrap } from "@kitesurf/jsrpc-types/page-script";

export declare const html: PageScriptBootstrap["html"];
export declare const url: PageScriptBootstrap["url"];
export declare const cookies: PageScriptBootstrap["cookies"];
export declare const scriptDescriptors: PageScriptBootstrap["scriptDescriptors"];
export declare const userAgent: PageScriptBootstrap["userAgent"];
export declare const referrer: PageScriptBootstrap["referrer"];
// The document response's Referrer-Policy header, verbatim ("" = none).
export declare const referrerPolicy: PageScriptBootstrap["referrerPolicy"];
// Manifest of which user-script buckets were baked into the modules-map.
export declare const hasClassicRegular: PageScriptBootstrap["hasClassicRegular"];
export declare const hasClassicAsync: PageScriptBootstrap["hasClassicAsync"];
export declare const moduleScriptCount: PageScriptBootstrap["moduleScriptCount"];
export declare const resourceDrainQuietTurns: PageScriptBootstrap["resourceDrainQuietTurns"];
export declare const pixelFree: PageScriptBootstrap["pixelFree"];
export declare const fontDefer: PageScriptBootstrap["fontDefer"];
export declare const moduleScriptUrls: PageScriptBootstrap["moduleScriptUrls"];
// Only URLs baked as JSON may answer a native JSON module import.
export declare const jsonModuleUrls: PageScriptBootstrap["jsonModuleUrls"];
export declare const cdpDebug: PageScriptBootstrap["cdpDebug"];
export declare const lagWatchdog: PageScriptBootstrap["lagWatchdog"];
export declare const csp: PageScriptBootstrap["csp"];
export declare const metaCsp: PageScriptBootstrap["metaCsp"];
export declare const insertedBaked: PageScriptBootstrap["insertedBaked"];
