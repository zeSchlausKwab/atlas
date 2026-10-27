import type {
  ChartData,
  ChartInput,
} from "../../../../packages/chat/src/analysis";
import type { ChatDataClient } from "./data-client";
import type { ChatLayers, InspectedFeature } from "./layers";
export interface ChartView extends ChartData {
  id: string;
}
interface State {
  charts: ChartView[];
  inspection: InspectedFeature | null;
  selectedCount: number;
  busy: boolean;
  error?: string;
}
/** Device-only chart memberships and source evidence; model replies stay concise. */
export class ChatInsights {
  private state: State = {
    charts: [],
    inspection: null,
    selectedCount: 0,
    busy: false,
  };
  private listeners = new Set<() => void>();
  private selection?: AbortController;
  private selectionChart?: string;
  private highlight?: string;
  private highlightChart?: string;
  constructor(
    private data: ChatDataClient,
    private layers: ChatLayers,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  private update(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    for (const f of this.listeners) f();
  }
  async show(input: ChartInput, signal: AbortSignal) {
    const data: ChartData = await this.data.call("__chart", input, signal);
    signal.throwIfAborted();
    const chart = { ...data, id: "chart-" + crypto.randomUUID() };
    this.update({ charts: [...this.state.charts, chart] });
    return {
      chart: chart.id,
      title: chart.title,
      kind: chart.kind,
      count: chart.count,
      unknownCount: chart.unknownCount,
      bins: chart.bars?.length,
      unit: chart.unit,
      provenance: chart.provenance,
      interaction:
        "Select bars, points or table rows to highlight cached source geometry.",
    };
  }
  remove(id: string) {
    if (!this.state.charts.some((c) => c.id === id))
      throw new Error("Unknown chart");
    if (this.highlightChart === id || this.selectionChart === id)
      this.clearSelection();
    this.update({ charts: this.state.charts.filter((c) => c.id !== id) });
    return { removed: id };
  }
  inspect(value: InspectedFeature | null) {
    this.update({
      inspection: value,
      error: value
        ? undefined
        : "No chat drawing at this position. Pick a colored feature.",
    });
  }
  dismissInspection() {
    this.update({ inspection: null, error: undefined });
  }
  clearSelection() {
    this.selection?.abort();
    this.selection = undefined;
    this.selectionChart = undefined;
    if (
      this.highlight &&
      this.layers.getSnapshot().some((l) => l.id === this.highlight)
    )
      this.layers.undo(this.highlight);
    this.highlight = undefined;
    this.highlightChart = undefined;
    this.update({ selectedCount: 0, busy: false, error: undefined });
  }
  async select(chart: ChartView, indexes: number[]) {
    this.selection?.abort();
    const abort = new AbortController();
    this.selection = abort;
    this.selectionChart = chart.id;
    this.update({ busy: true, error: undefined });
    try {
      const saved = await this.data.call(
        "__select",
        { result: chart.result, indexes },
        abort.signal,
      );
      const shapes = await this.data.call(
        "__resolve",
        { result: saved.result },
        abort.signal,
      );
      abort.signal.throwIfAborted();
      if (
        this.highlight &&
        this.layers.getSnapshot().some((l) => l.id === this.highlight)
      )
        this.layers.undo(this.highlight);
      this.highlight = this.layers.add(
        shapes.collection,
        "Chart selection · " + chart.title,
        "#d74627",
        saved.result,
        { fillOpacity: 0.5, strokeWidth: 3, pointRadius: 8 },
        [],
        shapes.meta,
      ).layer;
      this.highlightChart = chart.id;
      this.update({
        selectedCount: shapes.collection.features.length,
        busy: false,
      });
    } catch (e) {
      if (!abort.signal.aborted)
        this.update({
          busy: false,
          error: e instanceof Error ? e.message : String(e),
        });
    }
  }
  clear() {
    this.clearSelection();
    this.update({ charts: [], inspection: null, error: undefined });
  }
  destroy() {
    this.selection?.abort();
    this.listeners.clear();
  }
}
