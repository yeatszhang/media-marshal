import { nativeImage } from "electron";

export function trayIcon() {
  const size = 20;
  const bitmap = Buffer.alloc(size * size * 4);
  const pixel = (x: number, y: number) => {
    bitmap[(y * size + x) * 4 + 3] = 255;
  };
  for (let y = 6; y <= 16; y++)
    for (let x = 3; x <= 16; x++) {
      if (x === 3 || x === 16 || y === 6 || y === 16 || y === 7) pixel(x, y);
    }
  for (let y = 2; y <= 4; y++)
    for (let x = 3; x <= 16; x++) if ((x + y) % 6 < 4) pixel(x, y);
  const image = nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
  image.setTemplateImage(true);
  return image;
}
