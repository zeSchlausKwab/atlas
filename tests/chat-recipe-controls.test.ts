import { expect, test } from "bun:test";
import { ChatRecipes } from "../apps/web/src/chat/recipes";

test("recipe drawing is replaced only on successful completion; failed and cancelled reruns preserve it and export history", async () => {
  let fail = false,
    cancel: AbortController | undefined,
    adds = 0;
  const removed: string[] = [];
  const data = {
    call: async (name: string) => {
      if (name === "recipe_run") {
        if (fail) throw new Error("Recipe check failed");
        cancel?.abort();
        return {
          result: "geo-result",
          parameters: { distance: 200 },
          steps: [],
          count: 1,
          reusedSteps: 2,
        };
      }
      return {
        collection: { type: "FeatureCollection", features: [] },
        meta: {},
      };
    },
  };
  const layers = {
    add: () => ({ layer: "layer-" + ++adds }),
    undo: (id: string) => removed.push(id),
  };
  const recipes = new ChatRecipes(data as any, layers as any);
  recipes.add({
    recipe: "r",
    definition: { title: "test", steps: [], parameters: {}, output: "a" },
    parameters: {},
  });
  await recipes.run("r", {}, new AbortController().signal, () => {});
  expect(recipes.getSnapshot()[0]!.layer).toBe("layer-1");
  fail = true;
  await expect(
    recipes.run("r", {}, new AbortController().signal, () => {}),
  ).rejects.toThrow("check failed");
  expect(adds).toBe(1);
  expect(removed).toEqual([]);
  fail = false;
  cancel = new AbortController();
  await expect(recipes.run("r", {}, cancel.signal, () => {})).rejects.toThrow();
  expect(adds).toBe(1);
  expect(removed).toEqual([]);
  cancel = undefined;
  await recipes.run("r", {}, new AbortController().signal, () => {});
  expect(adds).toBe(2);
  expect(removed).toEqual(["layer-1"]);
  expect(recipes.getSnapshot()[0]!.history.map((h) => h.status)).toEqual([
    "complete",
    "error",
    "cancelled",
    "complete",
  ]);
  recipes.clear();
  expect(recipes.getSnapshot()).toEqual([]);
});
