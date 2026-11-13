import assert from 'node:assert/strict';
import { clampScale, clampTranslate, doubleTapScale, fitContain, maxScaleFor, zoomAround } from '../../ui/zoomMath.ts';

const view = { width: 400, height: 800 };

// Aspect ratio preserved, never stretched.
const photo = fitContain({ width: 4000, height: 3000 }, view);
assert.deepEqual(photo, { width: 400, height: 300 });
const receipt = fitContain({ width: 1000, height: 6000 }, view); // long receipt
assert.ok(Math.abs(receipt.width / receipt.height - 1000 / 6000) < 1e-9);
assert.equal(receipt.height, 800);

// Enough headroom to read small print: at least the original pixels 1:1.
assert.ok(maxScaleFor({ width: 4000, height: 3000 }, photo) >= 4000 / 400);
assert.ok(maxScaleFor({ width: 1000, height: 6000 }, receipt) * receipt.width >= 1000);
assert.equal(maxScaleFor({ width: 200, height: 100 }, fitContain({ width: 200, height: 100 }, view)), 4);
assert.ok(maxScaleFor({ width: 100000, height: 100 }, { width: 400, height: 1 }) <= 12);

// Double tap on a long receipt fills the width; on a photo it is 2.5x.
assert.ok(Math.abs(doubleTapScale(receipt, view, 12) * receipt.width - view.width) < 1e-6);
assert.equal(doubleTapScale(photo, view, 12), 2.5);

// Clamping: no zooming out below fit, no panning past the edges.
assert.equal(clampScale(0.3, 8), 1); assert.equal(clampScale(20, 8), 8);
assert.deepEqual(clampTranslate({ x: 999, y: -999 }, 1, photo, view), { x: 0, y: 0 });
const t = clampTranslate({ x: 999, y: -999 }, 4, photo, view); // 1600x1200 image in a 400x800 view
assert.deepEqual(t, { x: 600, y: -200 });

// Zooming keeps the point under the fingers fixed.
const f = { x: 50, y: -40 };
const t1 = zoomAround({ x: 0, y: 0 }, 1, 3, f, f);
assert.deepEqual(t1, { x: -100, y: 80 });
console.log('zoom math tests passed');
