package com.jrvsolutions.ponder;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android-only bridge for the Text size setting.
 *
 * Two jobs, both Android-only on purpose:
 *
 *  1. getSystemFontScale — the OS font-size multiplier (Settings > Display >
 *     Font size). Used once, on first run, to seed profiles.text_scale to the
 *     nearest rung so a reader who has already told Android they want large
 *     text does not have to tell Ponder as well.
 *
 *  2. pin — force the WebView's text zoom to 100%. Android's WebView applies
 *     the system font scale to web text by itself. Ponder now scales its own
 *     type through the --font-scale CSS variable, so without this the two
 *     multiply: a reader at 200% system font who picks "Large" (2x) in
 *     Settings would get 4x and a broken layout. After pinning, --font-scale
 *     is the only thing that resizes text, on both platforms.
 *
 * There is deliberately no iOS counterpart. WKWebView ignores Dynamic Type for
 * CSS pixel sizes, so on iOS nothing scales Ponder's text today and there is
 * nothing to pin. iOS readers start at Default and choose in Settings.
 */
@CapacitorPlugin(name = "TextZoom")
public class TextZoomPlugin extends Plugin {

  @PluginMethod
  public void getSystemFontScale(PluginCall call) {
    float scale = getContext().getResources().getConfiguration().fontScale;
    JSObject ret = new JSObject();
    ret.put("scale", scale);
    call.resolve(ret);
  }

  @PluginMethod
  public void pin(PluginCall call) {
    getActivity()
      .runOnUiThread(() -> {
        if (getBridge() != null && getBridge().getWebView() != null) {
          getBridge().getWebView().getSettings().setTextZoom(100);
        }
        call.resolve();
      });
  }
}
