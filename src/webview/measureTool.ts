// The Measure tool (as QGIS's): lengths of lines, areas of polygons and angles,
// clicked on the map. Distances and areas are ellipsoidal (WGS 84 geodesics) or
// Cartesian (in the map's coordinate system); without georeferencing, in pixels.
import {
  ANGLE_UNITS,
  AREA_UNITS,
  LENGTH_UNITS,
  formatAngle,
  formatArea,
  formatLength,
  formatPlain,
  geodesicAngle,
  geodesicDistance,
  geodesicPolygon,
  planarAngle,
  planarDistance,
  planarPolygon,
  type Point,
} from '../shared/measure';

export type MeasureMode = 'line' | 'area' | 'angle';

const SVG = (body: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Icons in the manner of QGIS's measure tools: a ruler, a ruled polygon, a protractor. */
export const MEASURE_ICONS: Record<MeasureMode, string> = {
  line: SVG(
    '<path d="M1.6 7.2 6 3.4l3.4 2.4 5-3.8" stroke-width="1.3"/><circle cx="1.6" cy="7.2" r="0.9" fill="currentColor"/><circle cx="14.4" cy="2" r="0.9" fill="currentColor"/><rect x="0.8" y="11" width="14.4" height="4" rx="0.5"/><path d="M3.2 11v1.8M5.6 11v1.1M8 11v1.8M10.4 11v1.1M12.8 11v1.8"/>',
  ),
  area: SVG(
    '<path d="M2.4 9 4.2 1.8l7.4-.6 2.6 5.6L9.4 9z" fill="currentColor" fill-opacity="0.25"/><rect x="0.8" y="11" width="14.4" height="4" rx="0.5"/><path d="M3.2 11v1.8M5.6 11v1.1M8 11v1.8M10.4 11v1.1M12.8 11v1.8"/>',
  ),
  angle: SVG('<path d="M1.6 14h13M1.6 14 11.4 2.4"/><path d="M8.6 14a7 7 0 0 0-2.3-5.2" stroke-dasharray="1.4 1"/><path d="M12.2 14a10.6 10.6 0 0 0-3.4-7.8"/>'),
};

export const MEASURE_LABELS: Record<MeasureMode, string> = { line: 'Measure line', area: 'Measure area', angle: 'Measure angle' };

/** What the tool needs from the viewer. */
export interface MeasureHost {
  /** Longitude / latitude of a canvas grid point; undefined without georeferencing. */
  toLonLat(gx: number, gy: number): Point | undefined;
  /** Canvas grid point of a longitude / latitude (with georeferencing). */
  toGrid(lon: number, lat: number): Point;
  /** Coordinates in the map's coordinate system (y up), with the units' name; undefined without georeferencing. */
  toCrs(gx: number, gy: number): Point | undefined;
  crsUnits(): { symbol: string; metres: number | undefined } | undefined;
  /** Canvas grid ↔ stage (CSS pixel) coordinates, at the current view. */
  gridToStage(gx: number, gy: number): Point;
  redraw(): void;
  /** The tool was turned on or off (the stage's cursor). */
  activeChanged(on: boolean): void;
}

/** A clicked point: longitude / latitude with georeferencing, canvas grid pixels without. */
interface Vertex {
  lonLat?: Point;
  grid?: Point;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class MeasureTool {
  mode: MeasureMode = 'line';
  private on = false;
  private points: Vertex[] = [];
  private finished = false;
  private hover: Vertex | undefined;
  private method: 'ellipsoidal' | 'cartesian' = 'ellipsoidal';
  private units: Record<MeasureMode, string> = { line: 'm', area: 'm2', angle: 'deg' };

  private readonly toggle = $<HTMLButtonElement>('measureToggle');
  private readonly menuButton = $<HTMLButtonElement>('measureMenuButton');
  private readonly menu = $<HTMLDivElement>('measureMenu');
  private readonly panel = $<HTMLElement>('measure');

  constructor(private readonly host: MeasureHost) {
    this.menu.replaceChildren(
      ...(Object.keys(MEASURE_LABELS) as MeasureMode[]).map((mode) => {
        const item = document.createElement('button');
        item.className = 'crs-choice measure-choice';
        item.setAttribute('role', 'menuitemradio');
        item.dataset.mode = mode;
        item.innerHTML = `${MEASURE_ICONS[mode]}<span class="crs-label"></span>`;
        item.querySelector('.crs-label')!.textContent = MEASURE_LABELS[mode];
        item.addEventListener('click', () => {
          this.closeMenu();
          this.setMode(mode);
          this.setOn(true);
        });
        return item;
      }),
    );
    this.toggle.addEventListener('click', () => this.setOn(!this.on));
    this.menuButton.addEventListener('click', () => (this.menu.hidden ? this.openMenu() : this.closeMenu()));
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (!this.menu.hidden && !this.menu.contains(t) && !this.menuButton.contains(t)) this.closeMenu();
    });
    this.menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeMenu();
        this.menuButton.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...this.menu.querySelectorAll<HTMLButtonElement>('button')];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    $<HTMLSelectElement>('measureMethod').addEventListener('change', (e) => {
      this.method = (e.target as HTMLSelectElement).value as 'ellipsoidal' | 'cartesian';
      this.fillUnits();
      this.update();
    });
    $<HTMLSelectElement>('measureUnits').addEventListener('change', (e) => {
      this.units[this.mode] = (e.target as HTMLSelectElement).value;
      this.update();
    });
    this.setMode('line');
  }

  get active(): boolean {
    return this.on;
  }

  /** Turns the tool on (opening its panel) or off (closing it, and clearing the measurement). */
  setOn(on: boolean): void {
    this.on = on;
    this.toggle.setAttribute('aria-pressed', String(on));
    this.panel.hidden = !on;
    if (!on) {
      this.points = [];
      this.finished = false;
      this.hover = undefined;
    }
    this.fillUnits();
    this.update();
    this.host.activeChanged(on);
  }

  /** The map changed (its coordinate system, or georeferencing came or went): units and results again. */
  refresh(): void {
    this.fillUnits();
    this.update();
  }

  setMode(mode: MeasureMode): void {
    if (mode !== this.mode) {
      this.points = [];
      this.finished = false;
    }
    this.mode = mode;
    this.toggle.innerHTML = MEASURE_ICONS[mode];
    this.toggle.title = `${MEASURE_LABELS[mode]} (R)`;
    this.toggle.setAttribute('aria-label', MEASURE_LABELS[mode]);
    $('measureTitle').textContent = MEASURE_LABELS[mode];
    for (const item of this.menu.querySelectorAll<HTMLButtonElement>('button')) item.setAttribute('aria-checked', String(item.dataset.mode === mode));
    this.fillUnits();
    this.update();
  }

  private openMenu(): void {
    this.menu.hidden = false;
    this.menuButton.setAttribute('aria-expanded', 'true');
    // Above the status bar, left-aligned with the split button.
    const r = this.toggle.getBoundingClientRect();
    this.menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - this.menu.offsetWidth - 4))}px`;
    this.menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
    this.menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }

  private closeMenu(): void {
    this.menu.hidden = true;
    this.menuButton.setAttribute('aria-expanded', 'false');
  }

  // --- Clicks on the map ---

  private vertex(gx: number, gy: number): Vertex | undefined {
    const lonLat = this.host.toLonLat(gx, gy);
    if (lonLat) return Number.isFinite(lonLat[0]) && Number.isFinite(lonLat[1]) ? { lonLat } : undefined;
    return { grid: [gx, gy] };
  }

  private stageOf(v: Vertex): Point {
    const g = v.lonLat ? this.host.toGrid(v.lonLat[0], v.lonLat[1]) : v.grid!;
    return this.host.gridToStage(g[0], g[1]);
  }

  /** A click at a canvas grid point (stage point `sx`, `sy`): adds a point (a finished measurement starts over). */
  click(gx: number, gy: number, sx: number, sy: number): void {
    if (!this.on) return;
    const v = this.vertex(gx, gy);
    if (!v) return;
    if (this.finished) {
      this.points = [];
      this.finished = false;
    }
    // The second click of a double-click lands on the last point: not a new one.
    const last = this.points.at(-1);
    if (last) {
      const [lx, ly] = this.stageOf(last);
      if (Math.hypot(lx - sx, ly - sy) < 3) return;
    }
    this.points.push(v);
    this.hover = v;
    if (this.mode === 'angle' && this.points.length === 3) this.finished = true;
    this.update();
  }

  /** Double-click: the measurement is complete. */
  finish(): void {
    if (!this.on || this.finished || !this.points.length) return;
    this.finished = true;
    this.update();
  }

  /** The pointer moved over the map (undefined: it left). */
  move(gx: number | undefined, gy: number | undefined): void {
    if (!this.on || this.finished || !this.points.length) return;
    this.hover = gx === undefined || gy === undefined ? undefined : this.vertex(gx, gy);
    this.update();
  }

  /** Backspace or right-click: removes the last point. */
  undo(): boolean {
    if (!this.on || !this.points.length) return false;
    this.points.pop();
    this.finished = false;
    this.update();
    return true;
  }

  /** Esc, or New measurement: starts over. */
  clear(): boolean {
    if (!this.on || !this.points.length) return false;
    this.points = [];
    this.finished = false;
    this.update();
    return true;
  }

  // --- Results ---

  /** The points measured: the clicked ones, and the pointer while measuring. */
  private measured(): Vertex[] {
    return !this.finished && this.hover && this.points.length ? [...this.points, this.hover] : this.points;
  }

  /** How measurements are made at present. */
  private kind(): 'ellipsoidal' | 'cartesian' | 'pixels' {
    return !this.host.crsUnits() ? 'pixels' : this.method;
  }

  /** Planar coordinates of a vertex (the map's coordinate system, or pixels with y up). */
  private planar(v: Vertex): Point {
    if (v.lonLat) {
      const g = this.host.toGrid(v.lonLat[0], v.lonLat[1]);
      return this.host.toCrs(g[0], g[1]) ?? [NaN, NaN];
    }
    return [v.grid![0], -v.grid![1]];
  }

  private length(a: Vertex, b: Vertex): number {
    return this.kind() === 'ellipsoidal' ? geodesicDistance(a.lonLat!, b.lonLat!) : planarDistance(this.planar(a), this.planar(b));
  }

  /** A length in the chosen units. */
  private formatLength(value: number): string {
    const kind = this.kind();
    if (kind === 'pixels') return formatPlain(value, 'px');
    if (kind === 'cartesian') {
      const u = this.host.crsUnits()!;
      return u.metres === undefined ? formatPlain(value, u.symbol) : formatLength(value * u.metres, this.units.line);
    }
    return formatLength(value, this.units.line);
  }

  private formatArea(value: number): string {
    const kind = this.kind();
    if (kind === 'pixels') return formatPlain(value, 'px', true);
    if (kind === 'cartesian') {
      const u = this.host.crsUnits()!;
      return u.metres === undefined ? formatPlain(value, u.symbol, true) : formatArea(value * u.metres * u.metres, this.units.area);
    }
    return formatArea(value, this.units.area);
  }

  private angle(pts: Vertex[]): number {
    return this.kind() === 'ellipsoidal' ? geodesicAngle(pts[0].lonLat!, pts[1].lonLat!, pts[2].lonLat!) : planarAngle(this.planar(pts[0]), this.planar(pts[1]), this.planar(pts[2]));
  }

  private polygon(pts: Vertex[]): { area: number; perimeter: number } {
    return this.kind() === 'ellipsoidal' ? geodesicPolygon(pts.map((p) => p.lonLat!)) : planarPolygon(pts.map((p) => this.planar(p)));
  }

  private fillUnits(): void {
    const methodRow = $('measureMethodRow');
    const kind = this.kind();
    methodRow.hidden = kind === 'pixels';
    $<HTMLSelectElement>('measureMethod').value = this.method;
    const select = $<HTMLSelectElement>('measureUnits');
    const u = this.host.crsUnits();
    let options: [string, string][];
    if (this.mode === 'angle') options = ANGLE_UNITS.map((a) => [a.id, a.label]);
    else if (kind === 'pixels') options = [['px', 'Pixels']];
    else if (kind === 'cartesian' && u?.metres === undefined) options = [['map', u?.symbol === '°' ? 'Degrees (map units)' : `Map units (${u?.symbol})`]];
    else {
      const units = this.mode === 'line' ? LENGTH_UNITS : AREA_UNITS;
      options = units.map((x): [string, string] => [x.id, x.label]);
    }
    select.replaceChildren(
      ...options.map(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        return o;
      }),
    );
    select.value = options.some(([v]) => v === this.units[this.mode]) ? this.units[this.mode] : options[0][0];
    select.disabled = options.length < 2;
  }

  /** Refreshes the panel and the drawing. */
  update(): void {
    const pts = this.measured();
    const body = $('measureSegments').querySelector('tbody')!;
    const results = $('measureResults');
    const hint = $('measureHint');
    const rows: [string, string][] = [];
    const segments: string[] = [];
    if (this.mode === 'line') {
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = this.length(pts[i - 1], pts[i]);
        total += d;
        segments.push(this.formatLength(d));
      }
      rows.push(['Total', pts.length > 1 ? this.formatLength(total) : '—']);
    } else if (this.mode === 'area') {
      const p = pts.length > 2 ? this.polygon(pts) : undefined;
      rows.push(['Area', p ? this.formatArea(p.area) : '—'], ['Perimeter', p ? this.formatLength(p.perimeter) : '—']);
    } else {
      rows.push(['Angle', pts.length === 3 ? formatAngle(this.angle(pts), this.units.angle) : '—']);
    }
    body.replaceChildren(
      ...segments.map((text, i) => {
        const tr = document.createElement('tr');
        const n = document.createElement('td');
        n.textContent = String(i + 1);
        const v = document.createElement('td');
        v.textContent = text;
        if (!this.finished && i === segments.length - 1 && this.hover && this.points.length) tr.className = 'live';
        tr.append(n, v);
        return tr;
      }),
    );
    $('measureSegments').hidden = this.mode !== 'line';
    results.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    const kind = this.kind();
    const how =
      kind === 'pixels'
        ? 'Measured in pixels of the image (it has no georeferencing).'
        : kind === 'ellipsoidal'
          ? this.mode === 'angle'
            ? 'Between geodesics on the WGS 84 ellipsoid.'
            : 'Along geodesics on the WGS 84 ellipsoid.'
          : 'On the plane of the map’s coordinate system.';
    const steps =
      this.mode === 'angle'
        ? 'Click a point on the first side, the vertex, then a point on the second side.'
        : `Click to add points; double-click to finish${this.mode === 'area' ? ' (the polygon closes itself)' : ''}.`;
    hint.textContent = `${steps} Right-click or Backspace removes the last point; Esc starts over. ${how}`;
    this.host.redraw();
  }

  // --- Drawing ---

  /** The measurement over the map (in stage coordinates, scaled by `dpr`). */
  draw(ctx: CanvasRenderingContext2D, dpr: number): void {
    if (!this.on) return;
    const pts = this.measured();
    if (!pts.length) return;
    const xy = pts.map((p) => this.stageOf(p));
    if (xy.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const path = new Path2D();
    xy.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    if (this.mode === 'area' && xy.length > 2) {
      path.closePath();
      ctx.fillStyle = 'rgba(227, 26, 28, 0.22)';
      ctx.fill(path);
    }
    // QGIS's measuring rubber band: red, over a white halo.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 4;
    ctx.stroke(path);
    ctx.strokeStyle = '#e31a1c';
    ctx.lineWidth = 2;
    ctx.stroke(path);
    if (this.mode === 'angle' && xy.length === 3) this.drawArc(ctx, xy);
    for (const [i, [x, y]] of xy.entries()) {
      if (!this.finished && i === xy.length - 1 && this.hover && this.points.length) continue;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#e31a1c';
      ctx.stroke();
    }
    // The result next to the last point (also in screenshots).
    const label = $('measureResults').querySelector('dd')?.textContent;
    if (label && label !== '—') {
      const [x, y] = this.mode === 'angle' && xy.length === 3 ? xy[1] : xy[xy.length - 1];
      ctx.font = '600 12px sans-serif';
      ctx.textBaseline = 'bottom';
      const w = ctx.measureText(label).width;
      const lx = Math.min(x + 8, ctx.canvas.width / dpr - w - 10);
      const ly = Math.max(y - 8, 20);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(lx - 3, ly - 16, w + 6, 18);
      ctx.fillStyle = '#b3000c';
      ctx.fillText(label, lx, ly);
    }
    ctx.restore();
  }

  /** The arc of the angle at its vertex. */
  private drawArc(ctx: CanvasRenderingContext2D, xy: Point[]): void {
    const [a, v, b] = xy;
    const t1 = Math.atan2(a[1] - v[1], a[0] - v[0]);
    let t2 = Math.atan2(b[1] - v[1], b[0] - v[0]);
    let d = t2 - t1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    t2 = t1 + d;
    const r = Math.max(8, Math.min(30, 0.4 * Math.min(Math.hypot(a[0] - v[0], a[1] - v[1]), Math.hypot(b[0] - v[0], b[1] - v[1]))));
    ctx.beginPath();
    ctx.moveTo(v[0], v[1]);
    ctx.arc(v[0], v[1], r, t1, t2, d < 0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(227, 26, 28, 0.22)';
    ctx.fill();
  }
}
