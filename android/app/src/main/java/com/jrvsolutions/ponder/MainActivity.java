package com.jrvsolutions.ponder;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Must be registered BEFORE super.onCreate — that is where Capacitor
    // builds the bridge and resolves the plugin registry.
    registerPlugin(TextZoomPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
