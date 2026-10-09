export type LngLat = [lng: number, lat: number];
export type Bounds = [west: number, south: number, east: number, north: number];

export interface ViewState {
  zoom: number;
  bounds: Bounds;
  pitch: number;
  bearing: number;
  center: LngLat;
  /** Map canvas height in CSS pixels (unknown: no far cutoff). */
  heightPx?: number;
}

/** Per-frame render origin: mercator units, and mercator units per metre at the origin. */
export interface Origin {
  x: number;
  y: number;
  scale: number;
}
