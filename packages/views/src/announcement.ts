import { finalizeEvent, verifyEvent, type Event } from "nostr-tools/pure";
import { parseViewRecipe, type ViewRecipe } from "./index";
/** App-specific addressable recipe; data remains pinned by Hashtree root. */
export const VIEW_KIND = 30065;
export function viewAnnouncement(
  recipe: ViewRecipe,
  key: Uint8Array,
  time = Math.floor(Date.now() / 1000),
): Event {
  const v = parseViewRecipe(recipe);
  return finalizeEvent(
    {
      kind: VIEW_KIND,
      created_at: time,
      tags: [
        ["d", `atlas-view/${v.id}`],
        ["t", "atlas-view"],
        ...v.sources.map((s) => ["hash", s.root]),
      ],
      content: JSON.stringify(v),
    },
    key,
  );
}
export function parseViewAnnouncement(
  value: unknown,
  author?: string,
): { event: Event; recipe: ViewRecipe } {
  if (JSON.stringify(value).length > 160 * 1024)
    throw new Error("Oversized view announcement");
  // Do not trust nostr-tools verification cache symbols on caller-owned objects.
  const e = JSON.parse(JSON.stringify(value)) as Event;
  if (
    !e ||
    e.kind !== VIEW_KIND ||
    !verifyEvent(e) ||
    (author && e.pubkey !== author) ||
    e.created_at > Math.floor(Date.now() / 1000) + 300
  )
    throw new Error("Invalid signed view recipe");
  const recipe = parseViewRecipe(JSON.parse(e.content));
  const ds = e.tags.filter((t) => t[0] === "d");
  if (
    ds.length !== 1 ||
    ds[0]?.[1] !== `atlas-view/${recipe.id}` ||
    !e.tags.some((t) => t[0] === "t" && t[1] === "atlas-view")
  )
    throw new Error("View identity mismatch");
  if (
    JSON.stringify(e.tags.filter((t) => t[0] === "hash").map((t) => t[1])) !==
    JSON.stringify(recipe.sources.map((s) => s.root))
  )
    throw new Error("View root tags mismatch");
  return { event: e, recipe };
}
