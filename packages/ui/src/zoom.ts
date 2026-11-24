interface Position {x: number; y: number}
interface Bounds {left: number; top: number; width: number}
export interface ZoomPreferences {value: string; locked: boolean}
interface ZoomOptions {
  native?: boolean;
  enabled?(): boolean;
  beforeChange?(): void;
  gesture?(): void;
  changed(): void;
  /** Height of the current PDF slide in document units, or null for blank pages. */
  slideHeight?(): number | null;
}
/** Named modes: fit the window width, or show the whole slide (width and height). */
const MODES = ['fit', 'page'];
export function zoomPreferences(value: unknown): ZoomPreferences {
  const candidate = value && typeof value === 'object' ? value as Partial<ZoomPreferences> : {};
  const number = Number(candidate.value);
  const mode = MODES.includes(String(candidate.value)) ? String(candidate.value) : !Number.isFinite(number) || number < 25 || number > 400 ? 'fit' : String(number);
  return {value: mode, locked: candidate.locked === true};
}
/** Screen → document before resizing, then document → screen afterwards. */
export function zoomAnchor(bounds: Bounds, width: number, position: Position): Position {
  const scale = bounds.width / width;
  return {x: (position.x - bounds.left) / scale, y: (position.y - bounds.top) / scale};
}
export function zoomScrollDelta(bounds: Bounds, width: number, anchor: Position, target: Position): Position {
  const scale = bounds.width / width;
  return {x: bounds.left + anchor.x * scale - target.x, y: bounds.top + anchor.y * scale - target.y};
}
/** Offer the new lock action once while preserving earlier toolbar choices. */
export function addZoomLockAction(toolbar: unknown, savedZoom: unknown): unknown {
  if (savedZoom != null || !toolbar || typeof toolbar !== 'object') return toolbar;
  const state = toolbar as {pinned?: unknown};
  if (!Array.isArray(state.pinned) || state.pinned.includes('zoom-lock')) return toolbar;
  const pinned = [...state.pinned], index = pinned.indexOf('zoom');
  pinned.splice(index < 0 ? pinned.length : index + 1, 0, 'zoom-lock');
  return {...state, pinned};
}

/** Document zoom shared by native AppKit pinch, browser trackpads and touch. */
export class ViewportZoom {
  private state: ZoomPreferences = {value: 'fit', locked: false};
  private pending: {factor: number; from: Position; to: Position} | null = null;
  private frame: number | null = null;
  private safariScale: number | null = null;
  private touch: {distance: number; center: Position} | null = null;
  constructor(
    private readonly paper: HTMLElement,
    private readonly viewport: HTMLElement,
    private readonly page: {width: number; height: number},
    private readonly options: ZoomOptions,
  ) {
    viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (options.native || this.safariScale !== null) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      this.queue(Math.exp(-delta * .01), {x: event.clientX, y: event.clientY});
    }, {passive: false});
    for (const name of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
      viewport.addEventListener(name, event => {
        event.preventDefault();
        if (options.native) return;
        const gesture = event as Event & {scale: number; clientX: number; clientY: number};
        if (name === 'gestureend') {this.safariScale = null; return;}
        if (!Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
        const previous = this.safariScale ?? gesture.scale;
        this.safariScale = gesture.scale;
        if (name === 'gesturechange') this.queue(gesture.scale / previous, {x: gesture.clientX, y: gesture.clientY});
      }, {passive: false});
    }
    window.addEventListener('livemitschrift-native-zoom', event => {
      if (!options.native) return;
      const sample = (event as CustomEvent<unknown>).detail as {phase?: string; magnification?: number; x?: number; y?: number} | null;
      if (!sample || ![sample.x, sample.y, sample.magnification].every(value => typeof value === 'number' && Number.isFinite(value))) return;
      const rect = viewport.getBoundingClientRect();
      if (sample.x! < rect.left || sample.x! > rect.right || sample.y! < rect.top || sample.y! > rect.bottom) return;
      if (sample.phase === 'change' || sample.phase === 'start') this.queue(1 + sample.magnification!, {x: sample.x!, y: sample.y!});
    });
    const touches = (event: TouchEvent): void => {
      if (event.touches.length !== 2) {this.touch = null; return;}
      event.preventDefault();
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      const next = {distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), center: {x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2}};
      if (this.touch && this.touch.distance > 0) this.queue(next.distance / this.touch.distance, next.center, this.touch.center);
      this.touch = next;
    };
    viewport.addEventListener('touchstart', touches, {passive: false});
    viewport.addEventListener('touchmove', touches, {passive: false});
    viewport.addEventListener('touchend', touches, {passive: false});
    viewport.addEventListener('touchcancel', () => {this.touch = null;}, {passive: true});
    window.addEventListener('blur', () => {this.cancel(); this.touch = null; this.safariScale = null;});
  }
  get preferences(): ZoomPreferences {return {...this.state};}
  get value(): string {return this.state.value;}
  get locked(): boolean {return this.state.locked;}
  get label(): string {return `${Math.round(this.paper.getBoundingClientRect().width / this.page.width * 100)} %`;}
  configure(value: unknown): void {this.state = zoomPreferences(value); this.resize(); if (this.state.locked && MODES.includes(this.state.value)) {this.state.value = String(this.paper.getBoundingClientRect().width / this.page.width * 100); this.resize();}}
  /**
   * Paper width in CSS pixels for "whole slide": the slide's document height
   * maps to the viewport's inner height, so width = innerHeight * pageWidth / slideHeight.
   */
  private pageModeWidth(): string {
    const slide = this.options.slideHeight?.() ?? null;
    if (!slide || slide <= 0) return '100%';
    const style = getComputedStyle(this.viewport);
    const height = this.viewport.clientHeight - parseFloat(style.paddingTop || '0') - 4;
    return `min(100%, ${Math.max(100, height * this.page.width / slide)}px)`;
  }
  resize(): void {
    this.paper.style.width = this.state.value === 'fit' ? '100%' : this.state.value === 'page' ? this.pageModeWidth() : `${this.page.width * Number(this.state.value) / 100}px`;
    const width = this.paper.getBoundingClientRect().width;
    if (width) this.paper.style.height = `${this.page.height * width / this.page.width}px`;
  }
  private center(): Position {const rect = this.viewport.getBoundingClientRect(); return {x: rect.left + this.viewport.clientWidth / 2, y: rect.top + this.viewport.clientHeight / 2};}
  set(value: string): void {
    if (this.locked) return;
    this.cancel(); this.apply(zoomPreferences({value}).value, this.center(), this.center());
  }
  setLocked(locked: boolean): void {
    this.cancel(); this.options.beforeChange?.();
    // Freeze the actual magnification, including a currently fitted page.
    if (locked && MODES.includes(this.value)) this.state.value = String(this.paper.getBoundingClientRect().width / this.page.width * 100);
    this.state.locked = locked; this.resize(); this.options.changed();
  }
  private cancel(): void {if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.pending = null;}
  private queue(factor: number, to: Position, from = to): void {
    if (this.locked || this.options.enabled?.() === false || document.querySelector('dialog[open]') || !Number.isFinite(factor) || factor <= 0) return;
    if (Math.abs(factor - 1) < 1e-8 && from.x === to.x && from.y === to.y) return;
    this.options.gesture?.();
    if (this.pending) {this.pending.factor *= factor; this.pending.to = to;}
    else this.pending = {factor, from, to};
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null; const pending = this.pending; this.pending = null;
      if (!pending || this.locked || this.options.enabled?.() === false || document.querySelector('dialog[open]')) return;
      const percent = this.paper.getBoundingClientRect().width / this.page.width * 100;
      this.apply(String(Math.max(25, Math.min(400, percent * pending.factor))), pending.from, pending.to);
    });
  }
  private apply(value: string, from: Position, to: Position): void {
    this.options.beforeChange?.();
    const anchor = zoomAnchor(this.paper.getBoundingClientRect(), this.page.width, from);
    this.state.value = value; this.resize();
    const delta = zoomScrollDelta(this.paper.getBoundingClientRect(), this.page.width, anchor, to);
    this.viewport.scrollLeft += delta.x; this.viewport.scrollTop += delta.y;
    this.options.changed();
  }
}

export function zoomControls(zoom: ViewportZoom): HTMLElement {
  const root = document.createElement('div'), select = document.createElement('select');
  select.setAttribute('aria-label', 'Zoom');
  select.title = 'Vergrößerung wählen, die Seite an die Fensterbreite anpassen oder die ganze Folie ohne Scrollen zeigen.';
  const label = document.createElement('label'); label.className = 'input-rate-option';
  const lock = document.createElement('input'); lock.type = 'checkbox'; lock.setAttribute('aria-label', 'Zoom fixieren');
  label.title = lock.title = 'Aktuelle Vergrößerung sperren. Zwei-Finger-Gesten und Zoomauswahl verändern sie dann nicht.';
  const sync = (): void => {
    const values = ['fit', 'page', '25', '50', '75', '100', '125', '150', '200', '300', '400'];
    if (!values.includes(zoom.value)) values.push(zoom.value);
    select.replaceChildren();
    for (const value of values) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'fit' ? 'An Fensterbreite anpassen' : value === 'page' ? 'Ganze Folie zeigen' : `${Math.round(Number(value))} %`;
      option.selected = value === zoom.value; select.append(option);
    }
    select.disabled = zoom.locked; lock.checked = zoom.locked;
  };
  select.addEventListener('change', () => {zoom.set(select.value); sync();});
  lock.addEventListener('change', () => {zoom.setLocked(lock.checked); sync();});
  label.append(lock, document.createTextNode('Zoom fixieren')); root.append(select, label); sync();
  return root;
}
