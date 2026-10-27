import type { Feature, FeatureCollection, Geometry } from "geojson";
import {
  aggregate,
  boundsOf,
  fc,
  numeric,
  property,
} from "../../spatial/src/index";
import type { ResultMeta } from "./geometry";
export interface AnalysisRow {
  id: string;
  properties: Record<string, unknown>;
  geometry?: Geometry;
}
export interface ChartInput {
  result: string;
  title: string;
  kind: "histogram" | "categories" | "scatter" | "table";
  field?: string;
  x?: string;
  y?: string;
  bins?: number;
  columns?: string[];
  unit?: string;
}
export interface ChartBin {
  label: string;
  count: number;
  indexes: number[];
  lower?: number;
  upper?: number;
}
export interface ChartData extends ChartInput {
  count: number;
  unknownCount: number;
  maxCount?: number;
  provenance: ResultMeta;
  bars?: ChartBin[];
  points?: Array<{ x: number; y: number; index: number; id: string }>;
  rows?: Array<{ index: number; id: string; values: unknown[] }>;
  unknownIndexes: number[];
}
export function normalizeRows(rows: unknown[]): AnalysisRow[] {
  return rows.map((value, index) => {
    const row = value as Record<string, unknown>;
    const geometry = (row.geometry ??
      (row.family === "locations" && row.coordinates
        ? { type: "Point", coordinates: row.coordinates }
        : undefined)) as Geometry | undefined;
    const {
      geometry: _geometry,
      coordinates: _coordinates,
      ...attributes
    } = row;
    const properties =
      row.type === "Feature"
        ? ((row.properties as Record<string, unknown>) ?? {})
        : attributes;
    return {
      id: String(row.id ?? properties.id ?? `feature-${index}`),
      properties: { ...properties, geometryType: geometry?.type ?? null },
      geometry,
    };
  });
}
export function rowFeatures(rows: AnalysisRow[]): FeatureCollection {
  return fc(
    rows.map((row) => {
      if (!row.geometry)
        throw new Error(
          "This result has no shapes. Prepare with geometry:true for spatial analysis or map selection.",
        );
      return {
        type: "Feature",
        id: row.id,
        geometry: row.geometry,
        properties: row.properties,
      };
    }),
  );
}
export function summary(rows: AnalysisRow[], field?: string) {
  const fields = new Map<string, Set<string>>(),
    geometryTypes: Record<string, number> = {};
  for (const row of rows) {
    const type = row.geometry?.type ?? "unavailable";
    geometryTypes[type] = (geometryTypes[type] ?? 0) + 1;
    for (const [key, value] of Object.entries(row.properties)) {
      const types = fields.get(key) ?? new Set<string>();
      types.add(value == null ? "null" : typeof value);
      fields.set(key, types);
    }
  }
  const values = field
    ? rows.map((row) => property(row.properties, field))
    : [];
  const categories = new Map<string, { value: unknown; count: number }>();
  const hasNumericValues = values.some(numeric);
  for (const v of values)
    if (v != null && !hasNumericValues) {
      const key = JSON.stringify(v),
        c = categories.get(key) ?? { value: v, count: 0 };
      c.count++;
      categories.set(key, c);
    }
  return {
    count: rows.length,
    geometryTypes,
    fields: Object.fromEntries([...fields].map(([key, v]) => [key, [...v]])),
    ...(field
      ? {
          field,
          statistics: aggregate(values),
          missingCount: values.filter((v) => v == null).length,
          categories: [...categories.values()].sort(
            (a, b) => b.count - a.count,
          ),
        }
      : {}),
  };
}
export interface ResultFilter {
  where?: Array<{ field: string; op: string; value: unknown }>;
  ids?: string[];
  sort?: { field: string; direction?: string };
  limit?: number;
}
export function filterRows(rows: AnalysisRow[], input: ResultFilter) {
  for (const c of input.where ?? []) {
    if (
      (c.op === "exists" && typeof c.value !== "boolean") ||
      (["gt", "gte", "lt", "lte"].includes(c.op) && !numeric(c.value)) ||
      (c.op === "contains" && typeof c.value !== "string")
    )
      throw new Error("Comparison value has the wrong type for " + c.op);
  }
  const ids = input.ids ? new Set(input.ids) : undefined;
  let filtered = rows.filter(
    (row) =>
      (!ids || ids.has(row.id)) &&
      (input.where ?? []).every((c) => {
        const v = property(row.properties, c.field);
        switch (c.op) {
          case "exists":
            return (v != null) === c.value;
          case "eq":
            return v === c.value;
          case "contains":
            return (
              typeof v === "string" &&
              typeof c.value === "string" &&
              v.toLocaleLowerCase().includes(c.value.toLocaleLowerCase())
            );
          case "gt":
            return numeric(v) && numeric(c.value) && v > c.value;
          case "gte":
            return numeric(v) && numeric(c.value) && v >= c.value;
          case "lt":
            return numeric(v) && numeric(c.value) && v < c.value;
          case "lte":
            return numeric(v) && numeric(c.value) && v <= c.value;
          default:
            throw new Error("Unknown comparison");
        }
      }),
  );
  const matched = filtered.length;
  if (input.sort) {
    const s = input.sort;
    filtered = filtered.slice().sort((a, b) => {
      const av = property(a.properties, s.field),
        bv = property(b.properties, s.field);
      if (av == null || bv == null)
        return av == null ? (bv == null ? 0 : 1) : -1;
      const cmp =
        numeric(av) && numeric(bv)
          ? av - bv
          : String(av).localeCompare(String(bv));
      return cmp * (s.direction === "desc" ? -1 : 1);
    });
  }
  if (input.limit !== undefined) filtered = filtered.slice(0, input.limit);
  return { rows: filtered, matched, limited: filtered.length < matched };
}
export function inspectRow(
  rows: AnalysisRow[],
  input: { id?: string; index?: number },
) {
  if ((input.id !== undefined) === (input.index !== undefined))
    throw new Error("Select exactly one feature id or index");
  const row =
    input.id !== undefined
      ? rows.find((r) => r.id === input.id)
      : rows[input.index!];
  if (!row) throw new Error("Feature is absent from this result");
  return {
    id: row.id,
    properties: row.properties,
    geometryType: row.geometry?.type ?? null,
    bounds: row.geometry
      ? boundsOf({ type: "Feature", geometry: row.geometry, properties: {} })
      : null,
  };
}
/** Full chart membership remains on the device; model tool replies contain only metadata. */
export function prepareChart(
  input: ChartInput,
  rows: AnalysisRow[],
  meta: ResultMeta,
): ChartData {
  const chart: ChartData = {
    ...input,
    count: rows.length,
    unknownCount: 0,
    unknownIndexes: [],
    provenance: meta,
  };
  if (input.kind === "table") {
    chart.columns = input.columns ?? ["name", "family", "category"];
    chart.rows = rows.map((r, index) => ({
      index,
      id: r.id,
      values: chart.columns!.map((c) => property(r.properties, c)),
    }));
  } else if (input.kind === "scatter") {
    if (!input.x || !input.y)
      throw new Error("Scatter needs x and y property names");
    chart.points = [];
    rows.forEach((r, index) => {
      const x = property(r.properties, input.x!),
        y = property(r.properties, input.y!);
      if (numeric(x) && numeric(y))
        chart.points!.push({ x, y, index, id: r.id });
      else chart.unknownIndexes.push(index);
    });
  } else {
    if (!input.field) throw new Error("Chart needs a field");
    if (input.kind === "categories") {
      const bins = new Map<string, ChartBin>();
      rows.forEach((r, index) => {
        const v = property(r.properties, input.field!);
        if (v == null) {
          chart.unknownIndexes.push(index);
          return;
        }
        const key = JSON.stringify(v),
          b = bins.get(key) ?? {
            label: typeof v === "string" ? v : key,
            count: 0,
            indexes: [],
          };
        b.count++;
        b.indexes.push(index);
        bins.set(key, b);
      });
      chart.bars = [...bins.values()].sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label),
      );
    } else {
      const values = rows.map((r, index) => ({
        v: property(r.properties, input.field!),
        index,
      }));
      let min = Infinity,
        max = -Infinity;
      for (const { v, index } of values) {
        if (numeric(v)) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        } else chart.unknownIndexes.push(index);
      }
      chart.bars = [];
      if (min !== Infinity) {
        const n = min === max ? 1 : (input.bins ?? 12),
          step = (max - min) / n;
        for (let i = 0; i < n; i++) {
          const lower = min + i * step,
            upper = i === n - 1 ? max : min + (i + 1) * step;
          chart.bars.push({
            label:
              min === max
                ? String(min)
                : `${format(lower)}–${format(upper)}${i === n - 1 ? " (inclusive)" : ""}`,
            lower,
            upper,
            count: 0,
            indexes: [],
          });
        }
        for (const { v, index } of values)
          if (numeric(v)) {
            const b =
              chart.bars[
                Math.min(n - 1, step === 0 ? 0 : Math.floor((v - min) / step))
              ]!;
            b.count++;
            b.indexes.push(index);
          }
      }
    }
  }
  chart.maxCount = chart.bars?.reduce((max, b) => Math.max(max, b.count), 1);
  chart.unknownCount = chart.unknownIndexes.length;
  return chart;
}
function format(v: number) {
  return Number(v.toPrecision(5)).toLocaleString("en-US");
}
