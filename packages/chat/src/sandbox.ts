/** Adapted from Earthly's chat/sandbox/transport/sandbox.worker.ts:
 * memoized QuickJS module, fresh VM per run, JSON-only inputs and deferred output.
 * Scripts have no host eval, browser objects, networking or credentials.
 */
import {
  getQuickJS,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  RELEASE_SYNC,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import { area } from "@turf/area";
import { booleanIntersects } from "@turf/boolean-intersects";
import type { FeatureCollection } from "geojson";
import { validateDrawing } from "./geometry";
let compiled: Promise<QuickJSWASMModule> | undefined;
function load() {
  if (!compiled) {
    const location = globalThis.location;
    compiled = (
      location?.protocol?.startsWith("http")
        ? newQuickJSWASMModuleFromVariant(
            newVariant(RELEASE_SYNC, {
              wasmLocation: new URL("/wasm/quickjs.wasm", location.origin).href,
            }),
          )
        : getQuickJS()
    ).catch((error) => {
      compiled = undefined;
      throw error;
    });
  }
  return compiled;
}
export interface CodeOutput {
  value: unknown;
  console: string[];
  collection?: FeatureCollection;
}
export async function runCode(
  code: string,
  data: unknown,
): Promise<CodeOutput> {
  const engine = await load(),
    runtime = engine.newRuntime(),
    vm = runtime.newContext();
  const lines: string[] = [];
  const output: FeatureCollection = { type: "FeatureCollection", features: [] };
  let emitted = false;
  try {
    const bind = (name: string, fn: (...args: any[]) => unknown) => {
      const handle = vm.newFunction(name, (...args) => {
        const value = fn(...args.map((h) => vm.dump(h)));
        if (value === undefined) return vm.undefined;
        return vm.unwrapResult(
          vm.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`),
        );
      });
      vm.setProp(vm.global, name, handle);
      handle.dispose();
    };
    bind("__log", (...args) => {
      lines.push(
        args
          .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
          .join(" "),
      );
    });
    bind("emit", (fc) => {
      validateDrawing(fc);
      for (const feature of fc.features) output.features.push(feature);
      emitted = true;
    });
    bind("__area", area);
    bind("__intersects", booleanIntersects);
    const setup = vm.unwrapResult(
      vm.evalCode(`
      globalThis.data = JSON.parse(${JSON.stringify(JSON.stringify(data))});
      globalThis.console = Object.freeze({ log: __log, warn: __log, error: __log });
      globalThis.geo = Object.freeze({ area: __area, intersects: __intersects });
      delete globalThis.__log; delete globalThis.__area; delete globalThis.__intersects;
      (function freeze(x) { if (x && typeof x === 'object') { Object.freeze(x); for (const k of Object.keys(x)) freeze(x[k]); } })(data);
    `),
    );
    setup.dispose();
    // Explicit return from a synchronous function body; no host objects cross the VM.
    const result = vm.evalCode(
      `(function(){
"use strict";
const encode = JSON.stringify;
const output = (function(){
${code}
})();
if (output && typeof output.then === 'function') throw new Error('Return a synchronous value; promises are not supported.');
try { const json = encode(output == null ? null : output); if (typeof json !== 'string') throw new Error('No JSON value'); return json; }
catch { throw new Error('Return a JSON-serializable summary; emit GeoJSON separately.'); }
})()`,
      "atlas-analysis.js",
    );
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw new Error(
        error && typeof error === "object"
          ? [error.name, error.message, error.stack].filter(Boolean).join("\n")
          : String(error),
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(vm.getString(result.value));
    } finally {
      result.value.dispose();
    }
    return {
      value: value ?? null,
      console: lines,
      ...(emitted ? { collection: output } : {}),
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
