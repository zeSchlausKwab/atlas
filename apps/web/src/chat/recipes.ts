import type { RecipeDefinition } from "../../../../packages/chat/src/recipes";
import type { ChatDataClient } from "./data-client";
import type { ChatLayers } from "./layers";
export interface RecipeView {
  recipe: string;
  definition: RecipeDefinition;
  parameters: Record<string, number>;
  running: boolean;
  progress?: string;
  error?: string;
  layer?: string;
  result?: string;
  count?: number;
  reusedSteps?: number;
  startedAt?: number;
  elapsedMs?: number;
  history: Array<Record<string, unknown>>;
}
export class ChatRecipes {
  private values: RecipeView[] = [];
  private listeners = new Set<() => void>();
  constructor(
    private data: ChatDataClient,
    private layers: ChatLayers,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.values;
  private update(id: string, patch: Partial<RecipeView>) {
    this.values = this.values.map((r) =>
      r.recipe === id ? { ...r, ...patch } : r,
    );
    for (const fn of this.listeners) fn();
  }
  add(value: any) {
    this.values = [...this.values, { ...value, running: false, history: [] }];
    for (const fn of this.listeners) fn();
  }
  async run(
    recipe: string,
    parameters: Record<string, number>,
    signal: AbortSignal,
    progress: (s: string) => void,
  ) {
    const previous = this.values.find((r) => r.recipe === recipe);
    if (!previous) throw new Error("Unknown recipe");
    if (previous.running) throw new Error("This recipe is already running");
    const startedAt = Date.now();
    this.update(recipe, {
      running: true,
      progress: "Preparing cached analysis…",
      error: undefined,
      startedAt,
      elapsedMs: undefined,
    });
    try {
      const result = await this.data.call(
        "recipe_run",
        { recipe, parameters },
        signal,
        (message) => {
          this.update(recipe, { progress: message });
          progress(message);
        },
      );
      const saved = await this.data.call(
        "__resolve",
        { result: result.result },
        signal,
      );
      signal.throwIfAborted();
      const drawing = this.layers.add(
        saved.collection,
        previous.definition.title,
        undefined,
        result.result,
        saved.meta.style,
        saved.meta.legend,
        {
          ...saved.meta,
          recipe,
          parameters: result.parameters,
          steps: result.steps,
        },
      );
      if (previous.layer) this.layers.undo(previous.layer);
      this.update(recipe, {
        running: false,
        parameters: result.parameters,
        layer: drawing.layer,
        result: result.result,
        count: result.count,
        reusedSteps: result.reusedSteps,
        progress: "Complete",
        elapsedMs: Date.now() - startedAt,
        history: [
          ...previous.history,
          {
            at: new Date(startedAt).toISOString(),
            parameters: result.parameters,
            steps: result.steps,
            result: result.result,
            count: result.count,
            execution: result.execution,
            elapsedMs: Date.now() - startedAt,
            status: "complete",
          },
        ],
      });
      return { ...result, drawing };
    } catch (e) {
      this.update(recipe, {
        running: false,
        error: signal.aborted ? "Cancelled; previous drawing kept." : String(e),
        elapsedMs: Date.now() - startedAt,
        history: [
          ...previous.history,
          {
            at: new Date(startedAt).toISOString(),
            parameters,
            status: signal.aborted ? "cancelled" : "error",
            error: String(e),
            elapsedMs: Date.now() - startedAt,
          },
        ],
      });
      throw e;
    }
  }
  clear() {
    this.values = [];
    for (const fn of this.listeners) fn();
  }
}
