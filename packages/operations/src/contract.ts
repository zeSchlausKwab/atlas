import type {
  Position,
  TransportMode,
  RouteResult,
  IsochroneResult,
} from "../../routing/src/index";
import type { SearchResult, ReverseResult } from "../../geocoding/src/index";
import type { FeatureQuery, FeatureResult } from "../../features/src/index";
import type { Selection } from "../../offline/src/index";
import type { AtlasReader } from "../../format/src/reader";
export interface OperationInputs {
  route: { start: Position; end: Position; profile?: TransportMode };
  isochrone: { start: Position; bands: number[]; profile?: TransportMode };
  search: { query: string; limit?: number };
  reverse: { point: Position };
  peak: Record<string, never>;
  features: FeatureQuery;
  offline: Selection;
}
export interface OperationResults {
  route: RouteResult;
  isochrone: IsochroneResult;
  search: SearchResult;
  reverse: ReverseResult;
  peak: Awaited<ReturnType<AtlasReader["highestPeak"]>>;
  features: FeatureResult;
  offline: Blob;
}
export type Operation = keyof OperationInputs;
