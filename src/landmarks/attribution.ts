import type { Map as MlMap } from 'maplibre-gl';

export const LICENCES_URL = 'https://open-landmarks.benmaps.fr/licenses/';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function attributionText(
  models: { attribution: string }[],
  catalogueAttribution?: string,
): string {
  const parts: string[] = [];
  const add = (t?: string) => {
    const v = t?.trim();
    if (v && !parts.includes(v)) parts.push(v);
  };
  add(catalogueAttribution);
  for (const m of models) add(m.attribution);
  if (!parts.some((p) => p.includes('OpenStreetMap'))) add('© OpenStreetMap contributors');
  return `<a href="${LICENCES_URL}" target="_blank" rel="noopener">${parts.map(escapeHtml).join('; ')}</a>`;
}

export type AttributionTarget = Pick<
  MlMap,
  'getLayer' | 'getSource' | 'addSource' | 'addLayer' | 'removeLayer' | 'removeSource'
>;

/**
 * Shows text in MapLibre's AttributionControl: an empty GeoJSON source carrying `attribution`,
 * plus an invisible layer so MapLibre counts the source as used.
 */
export class AttributionSource {
  private text = '';

  constructor(
    private readonly map: AttributionTarget,
    private readonly id: string,
  ) {}

  set(text: string): void {
    if (text === this.text) return;
    this.remove();
    if (!text) return;
    this.map.addSource(this.id, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      attribution: text,
    });
    this.map.addLayer({ id: this.id, type: 'fill', source: this.id, paint: { 'fill-opacity': 0 } });
    this.text = text;
  }

  /** Forget the source after the style was replaced (it is already gone). */
  reset(): void {
    this.text = '';
  }

  remove(): void {
    try {
      if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
      if (this.map.getSource(this.id)) this.map.removeSource(this.id);
    } catch {
      // The style was torn down (setStyle / map.remove).
    }
    this.text = '';
  }
}
