/* Every list that drops from a control (a helper search box's matches, a menu) lies over the page (#160): fixed to the
   frame's window and placed from its control's box after each render, scroll and resize. A list laid out in the flow
   pushed the line under its box down the page, and one laid out inside a card or dialog with its own scroll would be cut
   off by it. Which list is open is the app's state; this only places it. */

export interface DropRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

/* The part of the window that can be seen: with a phone's keyboard up that's less than the window. */
export interface DropView {
  top: number;
  h: number;
  w: number;
}

export interface DropPlace {
  top: number;
  left: number;
  maxHeight: number;
  up: boolean;
}

const GAP = 4, EDGE = 8;

/* full is the list's whole height, row one row's, width its width once its own limits apply. A long list scrolls inside
   itself at about 40% of what can be seen, never fewer than four rows where they fit. It opens upwards only where
   there's less room below than it wants and more above. end lines its right edge up with its control's, as a menu
   under a button at the end of a row does. */
export function placeDrop(r: DropRect, v: DropView, list: { full: number; row: number; width: number }, end = false): DropPlace {
  const below = v.top + v.h - r.bottom - EDGE, above = r.top - v.top - EDGE;
  const cap = Math.max(v.h * 0.4, list.row * 4 + 10);
  const want = Math.min(list.full, cap);
  const up = below < want && above > below;
  const maxHeight = Math.max(Math.min(want, up ? above : below), Math.min(list.full, list.row + 10));
  const top = up ? r.top - GAP - Math.min(list.full, maxHeight) : r.bottom + GAP;
  const from = end ? r.right - list.width : r.left;
  const left = Math.max(EDGE, Math.min(from, v.w - EDGE - list.width));
  return { top, left, maxHeight, up };
}

/* Whether a control has scrolled out of what can be seen, so its list closes rather than floating free of it. */
export function dropControlGone(r: DropRect, v: DropView): boolean {
  return !r.width || r.bottom < v.top || r.top > v.top + v.h;
}

export function dropView(): DropView {
  const vv = window.visualViewport;
  return { top: vv ? vv.offsetTop : 0, h: vv ? Math.min(vv.height, window.innerHeight) : window.innerHeight, w: document.documentElement.clientWidth };
}

export function openDrop(root: ParentNode): { list: HTMLElement; control: HTMLElement | null } | null {
  const list = root.querySelector<HTMLElement>(".drop:not([hidden])");
  if (!list) return null;
  return { list, control: root.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(list.id)}"]`) };
}

/* Places the open list, if any. Returns false when its control has gone or, on a scroll, left the view, for the caller to
   close it. A keyboard sliding up only moves it: the browser brings the focused box back into view straight after. */
export function placeOpenDrop(root: ParentNode, scrolled = false): boolean {
  const open = openDrop(root);
  if (!open) return true;
  const { list, control } = open;
  const r = control?.getBoundingClientRect(), v = dropView();
  if (!r || !r.width || (scrolled && dropControlGone(r, v))) return false;
  /* A menu keeps the width its own style gives it; a list of matches is at least as wide as its box. */
  if (!list.classList.contains("menu")) list.style.minWidth = `${Math.min(r.width, v.w - 2 * EDGE)}px`;
  list.style.maxWidth = `${v.w - 2 * EDGE}px`;
  const row = list.querySelector<HTMLElement>("li, button");
  const full = list.scrollHeight + list.offsetHeight - list.clientHeight;
  const at = placeDrop(r, v, { full, row: row?.offsetHeight ?? 40, width: list.offsetWidth }, list.dataset.align === "end");
  list.style.maxHeight = `${at.maxHeight}px`;
  list.style.top = `${at.top}px`;
  list.style.left = `${at.left}px`;
  list.classList.toggle("up", at.up);
  /* Arrows move the active option while focus stays in the box, so the list is scrolled to keep it in sight. */
  const active = list.querySelector<HTMLElement>(".active");
  if (active) {
    if (active.offsetTop < list.scrollTop) list.scrollTop = active.offsetTop;
    else if (active.offsetTop + active.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = active.offsetTop + active.offsetHeight - list.clientHeight;
  }
  return true;
}
