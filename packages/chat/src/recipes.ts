export interface RecipeParameter {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label?: string;
}
export interface RecipeStep {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface RecipeDefinition {
  title: string;
  parameters: Record<string, RecipeParameter>;
  steps: RecipeStep[];
  output: string;
}
const allowed = new Set([
  "result_filter",
  "result_merge",
  "result_style",
  "result_check",
  "spatial_measure",
  "spatial_points",
  "spatial_buffer",
  "spatial_overlay",
  "spatial_clip",
  "spatial_hull",
  "spatial_nearest",
  "spatial_join",
  "spatial_filter",
  "spatial_grid",
  "spatial_bands",
  "spatial_shape",
  "field_create",
  "field_contours",
]);
const name = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** Stable JSON key: object order is irrelevant; JSON-absent optional fields stay absent. */
export function canonical(value: unknown): string {
  const normalize = (v: any): any =>
    v && typeof v === "object"
      ? Array.isArray(v)
        ? v.map(normalize)
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, normalize(v[k])]),
          )
      : v;
  return JSON.stringify(normalize(value)) ?? "null";
}
function substitute(
  v: any,
  parameters: Record<string, number>,
  outputs: Map<string, any>,
): any {
  if (typeof v === "string" && v.startsWith("$param.")) {
    const k = v.slice(7);
    if (!Object.hasOwn(parameters, k))
      throw new Error("Unknown parameter " + k);
    return parameters[k];
  }
  if (typeof v === "string" && v.startsWith("$step.")) {
    const k = v.slice(6),
      r = outputs.get(k);
    if (!r) throw new Error("Unknown or forward step " + k);
    const ref = r.result ?? r.field;
    if (!ref) throw new Error("Step has no result " + k);
    return ref;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, parameters, outputs));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        substitute(x, parameters, outputs),
      ]),
    );
  return v;
}
/** Session-local recipes run trusted native operations, never generated code or network I/O. */
export class AnalysisRecipes {
  private values = new Map<
    string,
    {
      definition: RecipeDefinition;
      cache: Map<string, any>;
      parameters: Record<string, number>;
    }
  >();
  define(definition: RecipeDefinition) {
    if (!definition.title?.trim() || !definition.steps?.length)
      throw new Error("Recipe needs a title and steps");
    const parameters = Object.fromEntries(
      Object.entries(definition.parameters ?? {}).map(([k, p]) => {
        if (
          !name.test(k) ||
          ![p.min, p.max, p.value].every(Number.isFinite) ||
          p.min >= p.max ||
          p.value < p.min ||
          p.value > p.max ||
          (p.step !== undefined && (!Number.isFinite(p.step) || p.step <= 0))
        )
          throw new Error("Invalid recipe parameter " + k);
        return [k, p.value];
      }),
    );
    const seen = new Map<string, any>();
    for (const step of definition.steps) {
      if (!name.test(step.id) || seen.has(step.id) || !allowed.has(step.tool))
        throw new Error("Invalid or unsupported recipe step " + step.id);
      substitute(step.args, parameters, seen);
      seen.set(step.id, { result: "placeholder" });
    }
    if (!seen.has(definition.output)) throw new Error("Unknown recipe output");
    const recipe = "recipe-" + crypto.randomUUID();
    this.values.set(recipe, {
      definition: structuredClone(definition),
      parameters,
      cache: new Map(),
    });
    return { recipe, definition: structuredClone(definition), parameters };
  }
  async run(
    recipe: string,
    changes: Record<string, number>,
    invoke: (tool: string, args: any) => Promise<any>,
    signal: AbortSignal,
    progress: (s: string) => void,
  ) {
    const saved = this.values.get(recipe);
    if (!saved) throw new Error("Unknown recipe; recipes last for this chat");
    const parameters = { ...saved.parameters, ...changes },
      outputs = new Map<string, any>(),
      steps: any[] = [];
    for (const [k, v] of Object.entries(parameters)) {
      const p = saved.definition.parameters[k];
      if (
        !Object.hasOwn(saved.definition.parameters, k) ||
        !p ||
        !Number.isFinite(v) ||
        v < p.min ||
        v > p.max
      )
        throw new Error("Parameter out of range: " + k);
    }
    for (let i = 0; i < saved.definition.steps.length; i++) {
      signal.throwIfAborted();
      const step = saved.definition.steps[i]!,
        args = substitute(step.args, parameters, outputs),
        key = step.tool + canonical(args),
        cached = saved.cache.get(key);
      progress(
        `${saved.definition.title} · step ${i + 1}/${saved.definition.steps.length}: ${step.id}${cached ? " · reused" : ""}`,
      );
      const started = performance.now(),
        value = cached ?? (await invoke(step.tool, args));
      signal.throwIfAborted();
      if (step.tool === "result_check" && !value.checks.passed)
        throw new Error(
          "Recipe check failed: " +
            step.id +
            " " +
            JSON.stringify(value.checks),
        );
      saved.cache.set(key, value);
      outputs.set(step.id, value);
      steps.push({
        id: step.id,
        tool: step.tool,
        reused: !!cached,
        computeMs: performance.now() - started,
        count: value.count,
        checks: value.checks,
      });
    }
    const output = outputs.get(saved.definition.output);
    if (!output?.result)
      throw new Error("Recipe output must be a geometry result");
    saved.parameters = parameters;
    return {
      ...output,
      recipe,
      parameters,
      steps,
      definition: saved.definition,
      reusedSteps: steps.filter((s) => s.reused).length,
    };
  }
  clear() {
    this.values.clear();
  }
}
