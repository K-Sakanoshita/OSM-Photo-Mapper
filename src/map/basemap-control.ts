import type { IControl, Map } from 'maplibre-gl';
import { appAssetUrl, t } from '../i18n';

/** Basemap toggle using MapLibre's standard control layout. */
export class BasemapControl implements IControl {
  private container?: HTMLDivElement;
  private osmStandard = true;

  onAdd(map: Map): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '▱';
    button.style.fontSize = '24px';
    const updateLabel = () => {
      const label = t(this.osmStandard ? 'Switch map to OSMFJ' : 'Switch map to OSM Standard');
      button.title = label;
      button.setAttribute('aria-label', label);
    };
    updateLabel();
    button.onclick = () => {
      this.osmStandard = !this.osmStandard;
      map.setStyle(appAssetUrl(this.osmStandard ? 'tiles/osm_standard.json' : 'tiles/osmfj_poi.json'), { diff: false });
      updateLabel();
    };
    container.append(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = undefined;
  }
}
