import { expect, it } from "vite-plus/test";

import { buildLiquidGlassFilter } from "./filter";

it.each(["white", "rgb(40 100 200)"])(
  "preserves %s and its coverage when reconstructing translucent RGB samples",
  async (color) => {
    const { markup } = buildLiquidGlassFilter("alpha-test", {
      width: 100,
      height: 100,
    });
    const filter = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement
      .innerHTML;
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${filter}<rect width="100" height="100" fill="${color}" fill-opacity="0.5" filter="url(#alpha-test)"/><rect x="100" width="100" height="100" fill="${color}" fill-opacity="0.5"/></svg>`,
    )}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, 200, 100);
    context.drawImage(image, 0, 0);
    const actual = [...context.getImageData(50, 50, 1, 1).data];
    const expected = [...context.getImageData(150, 50, 1, 1).data];
    expect(actual).toEqual(expected);
  },
);
