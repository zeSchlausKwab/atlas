import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatRecipes, RecipeView } from "./recipes";
export function RecipePanel({
  recipes,
  disabled,
}: {
  recipes: ChatRecipes;
  disabled: boolean;
}) {
  const items = useSyncExternalStore(recipes.subscribe, recipes.getSnapshot);
  return (
    <>
      {items.map((r) => (
        <RecipeCard
          key={r.recipe}
          value={r}
          recipes={recipes}
          disabled={disabled || items.some((x) => x.running)}
        />
      ))}
    </>
  );
}
function RecipeCard({
  value: r,
  recipes,
  disabled,
}: {
  value: RecipeView;
  recipes: ChatRecipes;
  disabled: boolean;
}) {
  const [parameters, setParameters] = useState(r.parameters),
    [elapsed, setElapsed] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => setParameters(r.parameters), [r.parameters]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (!r.running) return;
    const update = () => setElapsed(Date.now() - (r.startedAt ?? Date.now()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [r.running, r.startedAt]);
  return (
    <section
      className="chat-recipe"
      aria-label={`Analysis recipe: ${r.definition.title}`}
    >
      <strong>{r.definition.title}</strong>
      {Object.entries(r.definition.parameters).map(([name, p]) => (
        <label key={name}>
          <span>
            {p.label ?? name} {p.unit && `(${p.unit})`}
          </span>
          <input
            aria-label={`${name} value`}
            type="number"
            min={p.min}
            max={p.max}
            step={p.step ?? "any"}
            value={parameters[name] ?? p.value}
            disabled={disabled}
            onChange={(e) =>
              setParameters({
                ...parameters,
                [name]: e.currentTarget.valueAsNumber,
              })
            }
          />
          <input
            aria-label={p.label ?? name}
            type="range"
            min={p.min}
            max={p.max}
            step={p.step ?? (p.max - p.min) / 100}
            value={parameters[name] ?? p.value}
            disabled={disabled}
            onChange={(e) =>
              setParameters({
                ...parameters,
                [name]: e.currentTarget.valueAsNumber,
              })
            }
          />
        </label>
      ))}
      {r.running ? (
        <p role="status">
          {r.progress} · {Math.floor(elapsed / 60000)}m{" "}
          {Math.floor(elapsed / 1000) % 60}s
        </p>
      ) : (
        r.count !== undefined && (
          <p>
            {r.count.toLocaleString()} results · {r.reusedSteps}/
            {r.definition.steps.length} steps reused ·{" "}
            {((r.elapsedMs ?? 0) / 1000).toFixed(1)} s
          </p>
        )
      )}
      {r.error && <p role="alert">{r.error}</p>}
      {r.running && abort.current ? (
        <button onClick={() => abort.current?.abort()}>Stop analysis</button>
      ) : (
        <button
          disabled={disabled}
          onClick={() => {
            const controller = new AbortController();
            abort.current = controller;
            void recipes
              .run(r.recipe, parameters, controller.signal, () => {})
              .catch(() => {})
              .finally(() => {
                abort.current = null;
              });
          }}
        >
          Rerun analysis
        </button>
      )}
      <p>
        Uses cached inputs on this device. No model call. Inputs keep their
        original coverage and snapshot.
      </p>
    </section>
  );
}
