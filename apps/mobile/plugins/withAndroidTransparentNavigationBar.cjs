const { withAndroidStyles } = require("expo/config-plugins");

// React Native's edge-to-edge setup keeps Android's contrast scrim, which paints the
// three-button bar white or black by system mode instead of showing the theme behind it.
module.exports = function withAndroidTransparentNavigationBar(config) {
  return withAndroidStyles(config, (config) => {
    const appTheme = config.modResults.resources.style?.find(
      (style) => style.$?.name === "AppTheme",
    );
    if (!appTheme) {
      throw new Error("withAndroidTransparentNavigationBar: AppTheme is missing from styles.xml.");
    }

    const name = "android:enforceNavigationBarContrast";
    appTheme.item ??= [];
    const existing = appTheme.item.find((item) => item.$?.name === name);
    if (existing) {
      existing._ = "false";
    } else {
      appTheme.item.push({ $: { name }, _: "false" });
    }

    return config;
  });
};
