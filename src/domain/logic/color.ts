/**
 * HSV ↔ HEX converters for the custom color picker (oak's CustomColorDialog
 * math). Pure and headless — the picker UI stays a thin shell over these.
 */

export interface Hsv {
  /** 0..360 */
  hue: number;
  /** 0..1 */
  saturation: number;
  /** 0..1 */
  value: number;
}

export function hsvToHex({ hue, saturation, value }: Hsv): string {
  const clampedHue = ((hue % 360) + 360) % 360;
  const chroma = saturation * value;
  const sector = clampedHue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (sector < 1) {
    red = chroma; green = secondary;
  } else if (sector < 2) {
    red = secondary; green = chroma;
  } else if (sector < 3) {
    green = chroma; blue = secondary;
  } else if (sector < 4) {
    green = secondary; blue = chroma;
  } else if (sector < 5) {
    red = secondary; blue = chroma;
  } else {
    red = chroma; blue = secondary;
  }
  const lift = value - chroma;
  const to255 = (channel: number): number => Math.round((channel + lift) * 255);
  const hex = (to255(red) << 16) | (to255(green) << 8) | to255(blue);
  return `#${hex.toString(16).padStart(6, "0")}`;
}

export function hexToHsv(hex: string): Hsv {
  const match = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (match === null) {
    return { hue: 0, saturation: 0, value: 0 };
  }
  const rgb = Number.parseInt(match[1]!, 16);
  const red = ((rgb >> 16) & 0xff) / 255;
  const green = ((rgb >> 8) & 0xff) / 255;
  const blue = (rgb & 0xff) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  let hue = 0;
  if (chroma > 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / chroma) % 6);
    } else if (max === green) {
      hue = 60 * ((blue - red) / chroma + 2);
    } else {
      hue = 60 * ((red - green) / chroma + 4);
    }
  }
  return { hue: ((hue % 360) + 360) % 360, saturation: max === 0 ? 0 : chroma / max, value: max };
}
