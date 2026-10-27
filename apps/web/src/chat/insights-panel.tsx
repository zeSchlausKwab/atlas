import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChartView, ChatInsights } from "./insights";
const text = (value: unknown) =>
  value == null
    ? "Unknown"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
const number = (n: number) => Number(n.toPrecision(5)).toLocaleString();
function Scatter({
  chart,
  insights,
}: {
  chart: ChartView;
  insights: ChatInsights;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    start = useRef<[number, number] | null>(null);
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const points = chart.points ?? [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const coords = (p: { x: number; y: number }): [number, number] => [
    36 + ((p.x - minX) / (maxX - minX || 1)) * 310,
    176 - ((p.y - minY) / (maxY - minY || 1)) * 148,
  ];
  useEffect(() => {
    const ctx = canvas.current!.getContext("2d")!;
    ctx.clearRect(0, 0, 370, 214);
    ctx.strokeStyle = "#ced4c3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(36, 15);
    ctx.lineTo(36, 177);
    ctx.lineTo(352, 177);
    ctx.stroke();
    ctx.fillStyle = "#367a89aa";
    for (const p of points) {
      const [x, y] = coords(p);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#354d41";
    ctx.fillText(chart.y ?? "", 4, 12);
    ctx.textAlign = "right";
    ctx.fillText(chart.x ?? "", 350, 211);
    if (points.length) {
      ctx.textAlign = "left";
      ctx.fillText(number(minX), 36, 191);
      ctx.textAlign = "right";
      ctx.fillText(number(maxX), 350, 191);
      ctx.fillText(number(maxY), 33, 29);
      ctx.fillText(number(minY), 33, 175);
    }
    if (box) {
      ctx.fillStyle = "#cf64292b";
      ctx.strokeStyle = "#ba502e";
      ctx.fillRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    }
  }, [chart, box]);
  const local = (e: React.PointerEvent): [number, number] => {
    const b = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - b.left) / b.width) * 370,
      ((e.clientY - b.top) / b.height) * 214,
    ];
  };
  return (
    <>
      <canvas
        ref={canvas}
        width={370}
        height={214}
        className="chat-scatter"
        aria-label={
          chart.title +
          " scatterplot. Drag a rectangle to select features; use the table alternative for keyboard selection."
        }
        onPointerDown={(e) => {
          start.current = local(e);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (start.current) {
            const p = local(e),
              s = start.current;
            setBox([
              Math.min(s[0], p[0]),
              Math.min(s[1], p[1]),
              Math.max(s[0], p[0]),
              Math.max(s[1], p[1]),
            ]);
          }
        }}
        onPointerUp={(e) => {
          const s = start.current;
          if (!s) return;
          start.current = null;
          const p = local(e);
          let selected: number[];
          if (Math.hypot(p[0] - s[0], p[1] - s[1]) < 5) {
            let best: { index: number; distance: number } | undefined;
            for (const f of points) {
              const q = coords(f),
                d = Math.hypot(q[0] - p[0], q[1] - p[1]);
              if (d < 10 && (!best || d < best.distance))
                best = { index: f.index, distance: d };
            }
            selected = best ? [best.index] : [];
          } else
            selected = points
              .filter((f) => {
                const q = coords(f);
                return (
                  q[0] >= Math.min(s[0], p[0]) &&
                  q[0] <= Math.max(s[0], p[0]) &&
                  q[1] >= Math.min(s[1], p[1]) &&
                  q[1] <= Math.max(s[1], p[1])
                );
              })
              .map((f) => f.index);
          setBox(null);
          void insights.select(chart, selected);
        }}
        onPointerCancel={() => {
          start.current = null;
          setBox(null);
        }}
      />
      <p className="chat-chart-note">
        Drag to select; click a point to highlight it.
      </p>
      <details>
        <summary>Accessible data table</summary>
        <DataTable
          chart={{
            ...chart,
            columns: [chart.x!, chart.y!],
            rows: points.map((p) => ({
              index: p.index,
              id: p.id,
              values: [p.x, p.y],
            })),
          }}
          insights={insights}
        />
      </details>
    </>
  );
}
function DataTable({
  chart,
  insights,
}: {
  chart: ChartView;
  insights: ChatInsights;
}) {
  const [page, setPage] = useState(0),
    rows = chart.rows ?? [],
    size = 20;
  return (
    <>
      <div className="chat-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              {chart.columns?.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * size, (page + 1) * size).map((r) => (
              <tr key={r.index}>
                <td>
                  <button
                    onClick={() => void insights.select(chart, [r.index])}
                  >
                    {r.id}
                  </button>
                </td>
                {r.values.map((v, i) => (
                  <td key={i}>{text(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > size && (
        <div className="chat-row">
          <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
            Previous rows
          </button>
          <span>
            {page * size + 1}–{Math.min(rows.length, (page + 1) * size)} /{" "}
            {rows.length}
          </span>
          <button
            disabled={(page + 1) * size >= rows.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Next rows
          </button>
        </div>
      )}
    </>
  );
}
export function InsightsPanel({ insights }: { insights: ChatInsights }) {
  const state = useSyncExternalStore(insights.subscribe, insights.getSnapshot),
    inspection = state.inspection;
  const inspectRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (inspection) inspectRef.current?.scrollIntoView({ block: "nearest" });
  }, [inspection]);
  if (!state.charts.length && !inspection && !state.error) return null;
  return (
    <section className="chat-insights" aria-label="Local analysis results">
      {!!state.charts.length && (
        <div className="chat-row">
          <span>
            {state.busy
              ? "Selecting cached features…"
              : `${state.selectedCount} highlighted from charts`}
          </span>
          <button onClick={() => insights.clearSelection()}>
            Clear highlight
          </button>
        </div>
      )}
      {state.error && (
        <p role="alert" className="chat-error">
          {state.error}
        </p>
      )}
      {state.charts.map((chart) => (
        <details className="chat-chart" key={chart.id} open>
          <summary>{chart.title}</summary>
          <div className="chat-chart-body">
            <p className="chat-chart-note">
              {chart.count.toLocaleString()} retained features ·{" "}
              {chart.unknownCount.toLocaleString()} missing or non-numeric
              {chart.unit ? ` · ${chart.unit}` : ""}
            </p>
            {chart.bars && (
              <div
                className="chat-bars"
                role="group"
                aria-label={chart.title + " categories"}
              >
                {chart.bars.map((bar, i) => (
                  <button
                    key={i}
                    onClick={() => void insights.select(chart, bar.indexes)}
                    title="Highlight these cached features"
                  >
                    <span>{bar.label}</span>
                    <span className="chat-bar-track">
                      <i
                        style={{
                          width:
                            (bar.count / (chart.maxCount ?? 1)) * 100 + "%",
                        }}
                      />
                    </span>
                    <b>{bar.count.toLocaleString()}</b>
                  </button>
                ))}
              </div>
            )}
            {chart.kind === "scatter" && (
              <Scatter chart={chart} insights={insights} />
            )}
            {chart.kind === "table" && (
              <DataTable chart={chart} insights={insights} />
            )}
            {!!chart.unknownIndexes.length && (
              <button
                className="chat-unknown"
                onClick={() =>
                  void insights.select(chart, chart.unknownIndexes)
                }
              >
                Highlight unknown values ({chart.unknownCount})
              </button>
            )}
            <div className="chat-row">
              <small>Selection uses cached geometry.</small>
              <button onClick={() => insights.remove(chart.id)}>
                Remove chart
              </button>
            </div>
            <details>
              <summary>Source evidence</summary>
              <pre>{JSON.stringify(chart.provenance, null, 2)}</pre>
            </details>
          </div>
        </details>
      ))}
      {inspection && (
        <section
          ref={inspectRef}
          className="chat-inspector"
          aria-label="Inspected feature"
        >
          <div className="chat-row">
            <strong>
              {String(
                inspection.properties?.name || inspection.id || "Feature",
              )}
            </strong>
            <button onClick={() => insights.dismissInspection()}>
              Close inspection
            </button>
          </div>
          <p>
            {inspection.geometryType} · {inspection.layer}
          </p>
          <dl>
            {Object.entries(inspection.properties ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{text(value)}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>Source evidence</summary>
            <pre>
              {JSON.stringify(
                {
                  id: inspection.id,
                  result: inspection.result,
                  provenance: inspection.provenance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </section>
      )}
    </section>
  );
}
