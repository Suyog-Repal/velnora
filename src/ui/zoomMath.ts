/**
 * Geometry of the attachment viewer. Coordinates are relative to the CENTRE of the viewport; the image is drawn at its
 * fitted (contain) size and transformed as   screen = translate + scale * point.
 */
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** Largest size with the image's aspect ratio that fits the viewport (never stretched, never cropped). */
export function fitContain(natural: Size, view: Size): Size {
  if (natural.width <= 0 || natural.height <= 0 || view.width <= 0 || view.height <= 0) return { width: view.width, height: view.height };
  const k = Math.min(view.width / natural.width, view.height / natural.height);
  return { width: natural.width * k, height: natural.height * k };
}

/**
 * Enough zoom to see the original pixels 1:1 and then some (for small receipt print), at least 4x, at most 12x.
 * A long receipt fitted to the screen height is narrow, so it gets more zoom headroom.
 */
export function maxScaleFor(natural: Size, fitted: Size): number {
  if (fitted.width <= 0) return 4;
  return Math.max(4, Math.min(12, (natural.width / fitted.width) * 2));
}

/** Double tap target: fill the screen width for a narrow (long) image, otherwise 2.5x. */
export function doubleTapScale(fitted: Size, view: Size, max: number): number {
  const fillWidth = fitted.width > 0 ? view.width / fitted.width : 2.5;
  return Math.min(max, fillWidth > 1.6 ? fillWidth : 2.5);
}

export function clampScale(s: number, max: number, min = 1): number {
  return Math.min(max, Math.max(min, s));
}

/** Keeps the zoomed image covering the viewport: no empty gap can be panned into view. */
export function clampTranslate(t: Point, scale: number, fitted: Size, view: Size): Point {
  const maxX = Math.max(0, (fitted.width * scale - view.width) / 2);
  const maxY = Math.max(0, (fitted.height * scale - view.height) / 2);
  // "+ 0" normalises -0 so a settled image reports exactly 0.
  return { x: Math.min(maxX, Math.max(-maxX, t.x)) + 0, y: Math.min(maxY, Math.max(-maxY, t.y)) + 0 };
}

/** New translation so the image point that was under `from` (at scale s0, translation t0) is under `to` at scale s1. */
export function zoomAround(t0: Point, s0: number, s1: number, from: Point, to: Point): Point {
  const px = (from.x - t0.x) / s0;
  const py = (from.y - t0.y) / s0;
  return { x: to.x - s1 * px, y: to.y - s1 * py };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
