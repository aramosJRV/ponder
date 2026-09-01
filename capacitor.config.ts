import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // Android package name. iOS deliberately differs — its bundle ID is
  // au.com.ponder.app, set in ios/App/App.xcodeproj (PRODUCT_BUNDLE_IDENTIFIER).
  // `cap sync` does not rewrite existing native bundle IDs, so this value only
  // affects newly added platforms. Do not "fix" the mismatch by regenerating iOS.
  appId: "com.jrvsolutions.ponder",
  appName: "Ponder",
  webDir: "dist",
  // Android 15+ (targetSdk 35+) forces the WebView edge-to-edge under the
  // status bar / nav bar at the OS level. Capacitor's own inset-margin fix
  // (CapacitorWebView.edgeToEdgeHandler) is opt-in and defaults to
  // "disable" — without this, nothing pushes content below the status bar
  // and headers render underneath it. "auto" only applies the margin when
  // the OS is actually enforcing edge-to-edge (API 35+, no theme opt-out),
  // so it's safe on older Android too. iOS is unaffected — it already
  // handles this via CSS env(safe-area-inset-*) on body.
  android: {
    adjustMarginsForEdgeToEdge: "auto",
  },
  plugins: {
    // iOS: resize the WKWebView itself so 100dvh / position:fixed shrink with
    // the keyboard. Android ignores `resize` — there the fix is
    // windowSoftInputMode="adjustResize" in AndroidManifest.xml plus the --kb
    // inset from lib/keyboardInset.ts, which is written to survive either
    // behaviour without double-counting.
    Keyboard: {
      resize: "native",
      resizeOnFullScreen: true,
    },
  },
};

export default config;
