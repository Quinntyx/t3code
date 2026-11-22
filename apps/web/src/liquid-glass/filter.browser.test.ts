import { expect, it } from "vite-plus/test";

import { buildLiquidGlassFilter } from "./filter";

// Window backdrops are opaque; translucent samples guard the rim's alpha reconstruction.
it.each([
  ["white", 0.5, 1],
  ["rgb(40 100 200)", 0.5, 1],
  ["rgb(40 100 200)", 1, 12],
])(
  "preserves %s at opacity %d and center blur %ipx across the rim and interior",
  async (color, opacity, centerBlur) => {
    const { markup } = buildLiquidGlassFilter(
      "alpha-test",
      { width: 100, height: 100, radius: 16 },
      { centerBlur },
    );
    const filter = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement
      .innerHTML;
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${filter}<rect width="100" height="100" fill="${color}" fill-opacity="${opacity}" filter="url(#alpha-test)"/><rect x="100" width="100" height="100" fill="${color}" fill-opacity="${opacity}"/></svg>`,
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
    const expected = [...context.getImageData(150, 50, 1, 1).data];
    // The second sample sits where the rim hands over to the interior blur.
    for (const x of [50, 20]) {
      const drift = [...context.getImageData(x, 50, 1, 1).data].map((channel, index) =>
        Math.abs(channel - (expected[index] ?? 0)),
      );
      expect(Math.max(...drift)).toBeLessThanOrEqual(1);
    }
  },
);
