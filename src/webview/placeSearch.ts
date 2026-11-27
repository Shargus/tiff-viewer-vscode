// OSM place search, as QGIS's "OSM place search" plugin (Nominatim Locator Filter):
// a search box above its status bar button, with the places found listed above it;
// choosing one shows the place. Places come from Nominatim, OpenStreetMap's search,
// asked as the plugin asks it, through the extension host. As in the plugin, a search
// starts on Enter, or on a space typed after at least four characters: Nominatim's
// usage policy forbids searching at every keystroke, and allows a request per second.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/** Nominatim's limit: one request per second. */
const MIN_INTERVAL = 1000;

export interface Place {
  name: string;
  detail: string;
  lon: number;
  lat: number;
  /** [west, south, east, north], when the place has an extent. */
  extent?: [number, number, number, number];
}

export interface PlaceSearchHost {
  /** Text fetched by the extension host. */
  fetchText(url: string): Promise<string>;
  /** Whether places can be searched (the map is georeferenced). */
  available(): boolean;
  /** The area suggestions are limited to (lon/lat [west, south, east, north]), when the view is bounded. */
  limit(): [number, number, number, number] | undefined;
  /** Whether a lon/lat point lies within the bounded map (always true when unbounded). */
  inside(lon: number, lat: number): boolean;
  /** Shows a chosen place. */
  show(place: Place): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** A Nominatim result (format=json, addressdetails, namedetails) as a place. */
export function nominatimPlace(item: Record<string, unknown>): Place | undefined {
  const lon = Number(item.lon);
  const lat = Number(item.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  const display = typeof item.display_name === 'string' ? item.display_name : '';
  const named = (item.namedetails as Record<string, string> | undefined)?.name;
  const name = (typeof item.name === 'string' && item.name) || named || display.split(',')[0] || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  // The kind of place (class and type, as the plugin lists them), then where it is.
  const kind = [item.class, item.type].filter((v) => typeof v === 'string' && v && v !== 'yes').join(' ').replace(/_/g, ' ');
  const rest = display.startsWith(name) ? display.slice(name.length).replace(/^,\s*/, '') : display;
  const detail = [kind, rest].filter(Boolean).join(' · ');
  // Nominatim's bounding box: [south, north, west, east], as strings.
  const b = Array.isArray(item.boundingbox) ? item.boundingbox.map(Number) : [];
  const extent: Place['extent'] = b.length === 4 && b.every(Number.isFinite) ? [Math.min(b[2], b[3]), Math.min(b[0], b[1]), Math.max(b[2], b[3]), Math.max(b[0], b[1])] : undefined;
  return { name, detail, lon, lat, extent };
}

export class PlaceSearch {
  private readonly button = $<HTMLButtonElement>('placeSearchToggle');
  private readonly box = $<HTMLDivElement>('placeSearch');
  private readonly input = $<HTMLInputElement>('placeInput');
  private readonly list = $<HTMLDivElement>('placeResults');
  private readonly status = $<HTMLDivElement>('placeStatus');
  private places: Place[] = [];
  private active = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request = 0;
  /** The language places are asked in (the setting, or VS Code's language). */
  language = 'en';
  /** When the last request went out (Nominatim allows one a second). */
  private lastRequest = 0;
  /** Results already fetched, by request URL (as Nominatim's policy asks). */
  private readonly cache = new Map<string, Place[]>();

  constructor(private readonly host: PlaceSearchHost) {
    this.button.addEventListener('click', () => (this.box.hidden ? this.open() : this.close()));
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (!this.box.hidden && !this.box.contains(t) && !this.button.contains(t)) this.close();
    });
    window.addEventListener('resize', () => this.place());
  }

  /** Enables the button when the map is georeferenced. */
  updateButton(): void {
    const ok = this.host.available();
    this.button.disabled = !ok;
    this.button.title = ok ? 'OSM place search: find a place by name (OpenStreetMap)' : 'OSM place search needs a georeferenced map';
    if (!ok) this.close();
  }

  open(): void {
    if (!this.host.available()) return;
    this.box.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.place();
    this.input.focus();
    this.input.select();
    if (this.input.value.trim().length >= 2 && !this.places.length) this.render([], 'Press Enter to search.');
  }

  close(): void {
    if (this.box.hidden) return;
    this.box.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    clearTimeout(this.timer);
    this.request++;
  }

  /** Above the status bar, left-aligned with the button. */
  private place(): void {
    if (this.box.hidden) return;
    const r = this.button.getBoundingClientRect();
    this.box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - this.box.offsetWidth - 4))}px`;
    this.box.style.bottom = `${window.innerHeight - r.top + 4}px`;
  }

  /** Typing: a space after at least four characters searches (as the plugin's locator); otherwise Enter does. */
  private onInput(): void {
    const text = this.input.value;
    const query = text.trim();
    if (query.length < 2) {
      clearTimeout(this.timer);
      this.request++;
      this.render([], '');
      return;
    }
    if (query.length >= 4 && text.endsWith(' ')) this.schedule();
    else if (!this.places.length) this.render([], 'Press Enter to search.');
  }

  /** Searches for what is typed, at most once a second. */
  private schedule(): void {
    clearTimeout(this.timer);
    const query = this.input.value.trim();
    if (query.length < 2) return;
    const wait = Math.max(0, this.lastRequest + MIN_INTERVAL - Date.now());
    this.timer = setTimeout(() => void this.search(query), wait);
  }

  private async search(query: string): Promise<void> {
    const id = ++this.request;
    const limit = this.host.limit();
    // The plugin's request.
    const params = new URLSearchParams({ q: query, extratags: '1', addressdetails: '1', namedetails: '1', limit: '40' });
    if (limit) {
      // viewbox: west, north, east, south (rounded as the plugin does), and only places within it.
      params.set('viewbox', [limit[0], limit[3], limit[2], limit[1]].map((v) => String(Math.round(v * 1e4) / 1e4)).join(','));
      params.set('bounded', '1');
    }
    // polygon_text changes the order of equally ranked places: asked as the plugin does.
    params.set('polygon_text', '1');
    params.set('format', 'json');
    params.set('accept-language', this.language);
    const url = `${NOMINATIM}?${params}`;
    const cached = this.cache.get(url);
    if (cached) return this.show(cached, limit);
    this.status.hidden = false;
    this.status.textContent = 'Searching…';
    this.lastRequest = Date.now();
    try {
      const json = JSON.parse(await this.host.fetchText(url)) as unknown;
      const places = (Array.isArray(json) ? json : []).map((item) => nominatimPlace(item as Record<string, unknown>)).filter((p): p is Place => !!p);
      this.cache.set(url, places);
      if (id === this.request) this.show(places, limit);
    } catch (error) {
      if (id === this.request) this.render([], `Search failed: ${(error as Error).message}`);
    }
  }

  /** Lists the places found (within the map, when it is bounded). */
  private show(places: Place[], limit: [number, number, number, number] | undefined): void {
    const shown = limit ? places.filter((p) => this.host.inside(p.lon, p.lat)) : places;
    this.render(shown, shown.length ? '' : limit ? 'No places found within the map’s extent.' : 'No places found.');
  }

  private render(places: Place[], message: string): void {
    this.places = places;
    this.active = -1;
    this.status.textContent = message;
    this.status.hidden = !message;
    // Best match nearest the search box (at the bottom).
    this.list.replaceChildren(
      ...places
        .map((place, i) => {
          const item = document.createElement('div');
          item.className = 'place-item';
          item.id = `place-${i}`;
          item.setAttribute('role', 'option');
          const name = document.createElement('span');
          name.className = 'place-name';
          name.textContent = place.name;
          const detail = document.createElement('span');
          detail.className = 'place-detail';
          detail.textContent = place.detail;
          item.append(name, detail);
          item.addEventListener('pointerdown', (e) => e.preventDefault());
          item.addEventListener('click', () => this.choose(i));
          item.addEventListener('pointermove', () => this.highlight(i));
          return item;
        })
        .reverse(),
    );
    this.list.hidden = !places.length;
    this.place();
  }

  private highlight(i: number): void {
    this.active = i;
    for (const item of this.list.children) item.classList.toggle('active', item.id === `place-${i}`);
    if (i >= 0) {
      this.input.setAttribute('aria-activedescendant', `place-${i}`);
      document.getElementById(`place-${i}`)?.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  private choose(i: number): void {
    const place = this.places[i];
    if (!place) return;
    this.close();
    this.host.show(place);
  }

  private onKey(e: KeyboardEvent): void {
    const n = this.places.length;
    // The list grows upwards: ArrowUp goes away from the box.
    if (e.key === 'ArrowUp' && n) this.highlight(this.active < 0 ? 0 : Math.min(n - 1, this.active + 1));
    else if (e.key === 'ArrowDown' && n) this.highlight(this.active <= 0 ? -1 : this.active - 1);
    else if (e.key === 'Enter') {
      // A highlighted place is chosen; otherwise Enter searches.
      if (n && this.active >= 0) this.choose(this.active);
      else this.schedule();
    } else if (e.key === 'Escape') {
      this.close();
      this.button.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
}
