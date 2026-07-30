import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // Android package name. iOS deliberately differs — its bundle ID is
  // au.com.ponder.app, set in ios/App/App.xcodeproj (PRODUCT_BUNDLE_IDENTIFIER).
  // `cap sync` does not rewrite existing native bundle IDs, so this value only
  // affects newly added platforms. Do not "fix" the mismatch by regenerating iOS.
  appId: "com.jrvsolutions.ponder",
  appName: "Ponder",
  webDir: "dist",
};

export default config;
