/**
 * pdf.js expects a few browser globals even when only extracting text. Provide tiny stand-ins so
 * the worker runs in plain Node without a canvas package.
 */
const g = globalThis as any;

if (typeof g.DOMMatrix === 'undefined') {
  class DOMMatrixPolyfill {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: number[] | string) {
      if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
    get is2D() { return true; }
    get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
    multiply(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
      return new DOMMatrixPolyfill([
        this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
        this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
        this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
      ]);
    }
    multiplySelf(o: DOMMatrixPolyfill): this { const m = this.multiply(o); Object.assign(this, m); return this; }
    preMultiplySelf(o: DOMMatrixPolyfill): this { const m = o.multiply(this); Object.assign(this, m); return this; }
    translate(x = 0, y = 0): DOMMatrixPolyfill { return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, x, y])); }
    translateSelf(x = 0, y = 0): this { return this.multiplySelf(new DOMMatrixPolyfill([1, 0, 0, 1, x, y])); }
    scale(sx = 1, sy = sx): DOMMatrixPolyfill { return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0])); }
    scaleSelf(sx = 1, sy = sx): this { return this.multiplySelf(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0])); }
    inverse(): DOMMatrixPolyfill {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return new DOMMatrixPolyfill([NaN, NaN, NaN, NaN, NaN, NaN]);
      return new DOMMatrixPolyfill([
        this.d / det, -this.b / det, -this.c / det, this.a / det,
        (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det,
      ]);
    }
    invertSelf(): this { Object.assign(this, this.inverse()); return this; }
    transformPoint(p: { x: number; y: number }) { return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f, z: 0, w: 1 }; }
    toFloat32Array() { return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
    toFloat64Array() { return new Float64Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
  }
  g.DOMMatrix = DOMMatrixPolyfill;
}

if (typeof g.Path2D === 'undefined') {
  g.Path2D = class Path2D { addPath() {} moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} bezierCurveTo() {} quadraticCurveTo() {} };
}

if (typeof g.ImageData === 'undefined') {
  g.ImageData = class ImageData {
    data: Uint8ClampedArray; width: number; height: number;
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (typeof dataOrWidth === 'number') { this.width = dataOrWidth; this.height = widthOrHeight; this.data = new Uint8ClampedArray(this.width * this.height * 4); }
      else { this.data = dataOrWidth; this.width = widthOrHeight; this.height = height ?? dataOrWidth.length / 4 / widthOrHeight; }
    }
  };
}
