import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTextScale } from "./lib/textScale";
import { pinWebViewTextZoom } from "./lib/nativeTextZoom";
import "./index.css";

// Before the first render, not in an effect: the type scale is driven by
// --font-scale, so applying it after mount would paint the whole app at 1x and
// then relayout in front of the reader.
initTextScale();

// Android's WebView scales web text by the system font size on its own. Stop
// it, so --font-scale is the only multiplier. Fire-and-forget: the bridge call
// is async but the pin lands long before a reader could notice, and blocking
// first paint on a native round trip is a worse trade than one reflow.
void pinWebViewTextZoom();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
