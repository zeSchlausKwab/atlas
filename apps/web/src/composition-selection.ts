import type { MapOffer } from "../../../packages/format/src/catalog";
import type { parseViewAnnouncement } from "../../../packages/views/src/announcement";
import type { ViewRecipe } from "../../../packages/views/src/index";

type PublishedView = ReturnType<typeof parseViewAnnouncement>;

/** Legacy single-map links select an announced map, never a raw HTTP file. */
export function requestedMapIds(query: URLSearchParams) {
  const value = query.get("maps") ?? query.get("map");
  return value === null ? undefined : value.split(",").filter(Boolean);
}

export function initialPublishedView(
  views: PublishedView[],
  publisher: string,
  requested: string | null,
) {
  const selected = views
    .filter(
      (v) =>
        v.event.pubkey === publisher &&
        (requested
          ? v.event.id === requested
          : v.event.tags.some(
              (tag) => tag[0] === "default" && tag[1] === "true",
            )),
    )
    .sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        a.event.id.localeCompare(b.event.id),
    )[0];
  if (requested && !selected)
    throw new Error(
      "The pinned view revision has not been announced by this relay. No maps were selected in its place.",
    );
  return selected;
}

/** Missing roots never broaden the selection to unrelated announced maps. */
export function resolveViewSources(
  view: Pick<ViewRecipe, "sources">,
  offers: MapOffer[],
) {
  return {
    available: new Map(
      offers.map((offer) => [
        offer,
        view.sources.find((source) => source.root === offer.hashtree?.root),
      ]),
    ),
    missing: view.sources.filter(
      (source) =>
        source.enabled &&
        !offers.some((offer) => offer.hashtree?.root === source.root),
    ),
  };
}
