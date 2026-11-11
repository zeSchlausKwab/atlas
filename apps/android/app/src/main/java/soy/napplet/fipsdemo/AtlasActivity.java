package soy.napplet.fipsdemo;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.*;
import android.os.Bundle;
import android.util.Log;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.json.*;

/** Native owns trust and sockets. Only bundled renderer code runs in the WebView. */
public final class AtlasActivity extends Activity {
  static {
    System.loadLibrary("soy_fips_demo");
  }

  private native boolean nativePrepare();

  private native void nativeRun(String settings);

  private native void nativeClose();

  private native boolean nativeSubmit(String request, boolean select);

  private final android.os.Handler lifecycleHandler =
      new android.os.Handler(android.os.Looper.getMainLooper());
  private final Runnable retryStart =
      () -> {
        if (this.foreground && this.autoConnect && this.hasSettings && !this.busy) start();
      };
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private LinearLayout root, settings, maps;
  private EditText address, peer, catalog, publisher;
  private RadioGroup transport;
  private TextView status, diagnostics;
  private Button connect, toggle, mapPicker, layerPicker;
  private JSONArray offers = new JSONArray(), profiles = new JSONArray();
  private String pendingRoot = "";
  private WebView web;
  private volatile boolean active = false;
  private boolean busy = false,
      foreground = false,
      pageReady = false,
      autoConnect = true,
      hasSettings = false;
  private JSONObject selected;
  private ConnectivityManager connectivity;
  private Network network;
  private ConnectivityManager.NetworkCallback networkCallback;
  private long bytes = 0, blobs = 0;
  private String carrier = "—";

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(243, 241, 233));
    root.setOnApplyWindowInsetsListener(
        (v, i) -> {
          android.graphics.Insets b =
              i.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
          v.setPadding(b.left, b.top, b.right, b.bottom);
          return i;
        });
    LinearLayout bar = new LinearLayout(this);
    bar.setGravity(Gravity.CENTER_VERTICAL);
    bar.setPadding(dp(12), 0, dp(8), 0);
    TextView title = text("atlas. / Native FIPS", 21);
    bar.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
    toggle = button("Connection");
    bar.addView(toggle);
    root.addView(bar);
    ScrollView scroll = new ScrollView(this);
    settings = column();
    settings.setPadding(dp(16), 0, dp(16), dp(12));
    scroll.addView(settings);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, dp(300)));
    toggle.setOnClickListener(
        v ->
            scroll.setVisibility(
                scroll.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
    transport = new RadioGroup(this);
    transport.setOrientation(LinearLayout.HORIZONTAL);
    for (String label : new String[] {"TCP", "UDP"}) {
      RadioButton b = new RadioButton(this);
      b.setText(label);
      b.setId(label.equals("TCP") ? R.id.tcp : R.id.udp);
      transport.addView(b);
    }
    transport.check(R.id.tcp);
    settings.addView(transport);
    address = field("Numeric peer endpoint", "192.168.0.250:42131");
    peer = field("Pinned FIPS identity · npub", "");
    catalog = field("Discovery catalog · SHA-256", "");
    publisher = field("Trusted map publisher · hex", "");
    Button paste = button("Paste connection JSON");
    settings.addView(paste);
    paste.setOnClickListener(v -> paste());
    TextView note =
        text(
            "Direct native TCP or UDP. No DNS, WebSocket, HTTP fallback or VPN. Discovery is a"
                + " signed snapshot from this peer; reconnect with new details to update it.",
            12);
    settings.addView(note);
    connect = button("Connect & discover");
    root.addView(connect);
    connect.setOnClickListener(
        v -> {
          if (busy) {
            autoConnect = false;
            disconnect("Disconnected by you");
          } else {
            autoConnect = true;
            start();
          }
        });
    status = text("Ready · paste the provider’s public connection details", 14);
    status.setPadding(dp(16), dp(4), dp(16), dp(4));
    root.addView(status);
    diagnostics = text("0 verified bytes · 0 blobs", 12);
    diagnostics.setPadding(dp(16), 0, dp(16), dp(4));
    root.addView(diagnostics);
    maps = new LinearLayout(this);
    maps.setPadding(dp(12), 0, dp(12), 0);
    mapPicker = button("Hosted maps");
    mapPicker.setEnabled(false);
    maps.addView(mapPicker, new LinearLayout.LayoutParams(0, -2, 1));
    layerPicker = button("Layers");
    layerPicker.setEnabled(false);
    maps.addView(layerPicker);
    mapPicker.setOnClickListener(v -> chooseMap());
    layerPicker.setOnClickListener(v -> chooseLayers());
    root.addView(maps);
    createWeb();
    setContentView(root);
    String saved =
        state == null
            ? getPreferences(0).getString("connection", null)
            : state.getString("connection");
    if (saved != null) apply(saved);
    else
      try {
        apply(readAsset("connection.json"));
      } catch (Exception ignored) {
      }
    try {
      profiles = new JSONArray(readAsset("connections.json"));
    } catch (Exception ignored) {
    }
    transport.setOnCheckedChangeListener(
        (group, id) -> {
          if (busy) return;
          String wanted = id == R.id.tcp ? "tcp" : "udp";
          for (int n = 0; n < profiles.length(); n++) {
            JSONObject profile = profiles.optJSONObject(n);
            if (profile != null && wanted.equals(profile.optString("transport"))) {
              apply(profile.toString());
              break;
            }
          }
        });
    applyIntent(getIntent());
    connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    network = connectivity.getActiveNetwork();
    networkCallback =
        new ConnectivityManager.NetworkCallback() {
          @Override
          public void onAvailable(Network next) {
            runOnUiThread(
                () -> {
                  if (active && network != null && !network.equals(next))
                    disconnect("Network changed · reconnect to authenticate the peer again");
                  network = next;
                  if (foreground && autoConnect && hasSettings && !busy) start();
                });
          }

          @Override
          public void onLost(Network lost) {
            runOnUiThread(
                () -> {
                  if (lost.equals(network)) {
                    network = null;
                    if (active)
                      disconnect("Network disconnected · restore connectivity, then reconnect");
                  }
                });
          }
        };
    connectivity.registerDefaultNetworkCallback(networkCallback);
  }

  private int dp(int x) {
    return Math.round(x * getResources().getDisplayMetrics().density);
  }

  private LinearLayout column() {
    LinearLayout l = new LinearLayout(this);
    l.setOrientation(LinearLayout.VERTICAL);
    return l;
  }

  private TextView text(String value, int size) {
    TextView t = new TextView(this);
    t.setText(value);
    t.setTextColor(Color.rgb(38, 60, 50));
    t.setTextSize(size);
    return t;
  }

  private Button button(String value) {
    Button b = new Button(this);
    b.setText(value);
    b.setAllCaps(false);
    return b;
  }

  private EditText field(String label, String hint) {
    TextView caption = text(label, 12);
    settings.addView(caption);
    EditText e = new EditText(this);
    e.setId(View.generateViewId());
    caption.setLabelFor(e.getId());
    e.setSingleLine(true);
    e.setTextSize(13);
    e.setHint(hint);
    e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
    settings.addView(e);
    return e;
  }

  private void paste() {
    EditText input = new EditText(this);
    input.setMinLines(4);
    new AlertDialog.Builder(this)
        .setTitle("Public connection details")
        .setMessage("Paste the JSON from atlas-peer. No secret keys are needed.")
        .setView(input)
        .setPositiveButton("Use details", (d, w) -> apply(input.getText().toString()))
        .setNegativeButton("Cancel", null)
        .show();
  }

  private void apply(String value) {
    try {
      if (value.length() > 4096) throw new Exception("Connection details too long");
      JSONObject c = new JSONObject(value);
      String t = c.getString("transport");
      if (!t.equals("tcp") && !t.equals("udp")) throw new Exception("Choose TCP or UDP");
      transport.check(t.equals("tcp") ? R.id.tcp : R.id.udp);
      address.setText(c.getString("address"));
      peer.setText(c.getString("peer"));
      catalog.setText(c.getString("catalog"));
      publisher.setText(c.getString("publisher"));
      hasSettings = true;
      status.setText("Details loaded · automatic native connection");
    } catch (Exception e) {
      status.setText("Invalid connection details: " + e.getMessage());
    }
  }

  private void applyIntent(Intent intent) {
    String c = intent.getStringExtra("config");
    if (c != null && !busy) apply(c);
  }

  @Override
  protected void onNewIntent(Intent i) {
    super.onNewIntent(i);
    applyIntent(i);
  }

  private String config() throws JSONException {
    JSONObject c = new JSONObject();
    c.put("transport", transport.getCheckedRadioButtonId() == R.id.tcp ? "tcp" : "udp");
    c.put("address", address.getText().toString().trim());
    c.put("peer", peer.getText().toString().trim());
    c.put("catalog", catalog.getText().toString().trim());
    c.put("publisher", publisher.getText().toString().trim());
    return c.toString();
  }

  private void start() {
    if (!foreground || busy || isDestroyed()) return;
    lifecycleHandler.removeCallbacks(retryStart);
    try {
      String c = config();
      if (!nativePrepare()) {
        status.setText("Previous connection is closing · reconnecting automatically…");
        lifecycleHandler.postDelayed(retryStart, 250);
        return;
      }
      busy = true;
      active = true;
      bytes = 0;
      blobs = 0;
      selected = null;
      mapPicker.setEnabled(false);
      layerPicker.setEnabled(false);
      carrier = transport.getCheckedRadioButtonId() == R.id.tcp ? "tcp" : "udp";
      getPreferences(0).edit().putString("connection", c).apply();
      connect.setText("Cancel / disconnect");
      status.setText("Starting native FIPS…");
      setInputs(false);
      worker.execute(() -> nativeRun(c));
    } catch (Exception e) {
      status.setText("Could not connect: " + e.getMessage());
    }
  }

  private void setInputs(boolean enabled) {
    address.setEnabled(enabled);
    peer.setEnabled(enabled);
    catalog.setEnabled(enabled);
    publisher.setEnabled(enabled);
    for (int n = 0; n < transport.getChildCount(); n++) transport.getChildAt(n).setEnabled(enabled);
  }

  private void disconnect(String reason) {
    lifecycleHandler.removeCallbacks(retryStart);
    active = false;
    selected = null;
    nativeClose();
    mapPicker.setEnabled(false);
    layerPicker.setEnabled(false);
    if (web != null) web.evaluateJavascript("window.closeAtlas && window.closeAtlas()", null);
    status.setText(reason);
    Log.i("AtlasNative", "closed " + reason);
    connect.setText("Closing native connection…");
    connect.setEnabled(false);
  }

  public void onAtlasEvent(String json) {
    runOnUiThread(
        () -> {
          if (isDestroyed()) return;
          try {
            JSONObject e = new JSONObject(json);
            String stage = e.getString("stage");
            if (stage.equals("closed") || stage.equals("error")) {
              active = false;
              busy = false;
              selected = null;
              mapPicker.setEnabled(false);
              layerPicker.setEnabled(false);
              setInputs(true);
              connect.setText("Reconnect & discover");
              connect.setEnabled(true);
              if (web != null)
                web.evaluateJavascript("window.closeAtlas && window.closeAtlas()", null);
              if (stage.equals("error")) status.setText(e.getString("message"));
              Log.i("AtlasNative", stage + " " + e.optString("message"));
              if (stage.equals("closed")
                  && foreground
                  && autoConnect
                  && hasSettings
                  && network != null) start();
              return;
            }
            if (!active || !foreground) return;
            if (e.has("bytes")) {
              bytes = e.getLong("bytes");
              blobs = e.optLong("blobs");
              diagnostics.setText(
                  carrier.toUpperCase(java.util.Locale.ROOT)
                      + " · "
                      + String.format(java.util.Locale.ROOT, "%,d", bytes)
                      + " verified bytes · "
                      + blobs
                      + " blobs · pinned peer");
            }
            if (stage.equals("blob")) {
              if (pageReady)
                web.evaluateJavascript("window.atlasResponse(" + e.toString() + ")", null);
              Log.i(
                  "AtlasNative",
                  e.has("error")
                      ? "resource denied: " + e.optString("error")
                      : "verified carrier=" + carrier + " bytes=" + bytes + " blobs=" + blobs);
              return;
            }
            if (stage.equals("receiving")) {
              status.setText(e.optString("message"));
              return;
            }
            status.setText(e.optString("message"));
            Log.i("AtlasNative", stage + " carrier=" + carrier);
            if (stage.equals("catalog")) {
              offers = e.getJSONArray("offers");
              mapPicker.setEnabled(offers.length() > 0);
              String preferred = getPreferences(0).getString("map:" + publisher.getText(), "");
              int choice = 0;
              for (int n = 0; n < offers.length(); n++)
                if (preferred.equals(rootOf(offers.getJSONObject(n)))) choice = n;
              if (offers.length() > 0) selectMap(offers.getJSONObject(choice));
            }
            if (stage.equals("selected")) {
              JSONObject offer = e.getJSONObject("offer");
              if (!rootOf(offer).equals(pendingRoot)) return;
              selected = offer;
              getPreferences(0).edit().putString("map:" + publisher.getText(), pendingRoot).apply();
              mapPicker.setText(mapName(offer));
              layerPicker.setEnabled(true);
              ((View) settings.getParent()).setVisibility(View.GONE);
              Log.i("AtlasNative", "selected root=" + pendingRoot + " name=" + mapName(offer));
              openSelected();
            }
          } catch (Exception e) {
            disconnect("Could not process native result: " + e.getMessage());
          }
        });
  }

  private String rootOf(JSONObject offer) {
    return offer.optJSONObject("hashtree").optString("root");
  }

  private String mapName(JSONObject offer) {
    JSONObject m = offer.optJSONObject("manifest");
    String name = m.optString("name", "Atlas map");
    JSONArray rasters = m.optJSONArray("rasters");
    if (rasters != null && rasters.length() > 0) {
      JSONObject mb = rasters.optJSONObject(0).optJSONObject("mbtiles");
      JSONObject meta = mb == null ? null : mb.optJSONObject("metadata");
      String description = meta == null ? "" : meta.optString("description");
      if (description.startsWith("Region ") && description.contains(" extract from "))
        name = "Satellite · " + description.substring(7, description.indexOf(" extract from "));
    }
    return name;
  }

  private void selectMap(JSONObject offer) {
    if (!active) return;
    selected = null;
    layerPicker.setEnabled(false);
    web.evaluateJavascript("window.closeAtlas && window.closeAtlas()", null);
    pendingRoot = rootOf(offer);
    status.setText("Opening " + mapName(offer) + "…");
    if (!nativeSubmit(pendingRoot, true)) disconnect("Native queue unavailable · reconnect");
  }

  private void chooseMap() {
    if (!active || offers.length() == 0) return;
    String[] names = new String[offers.length()];
    int current = -1;
    for (int n = 0; n < offers.length(); n++) {
      JSONObject offer = offers.optJSONObject(n);
      names[n] =
          mapName(offer)
              + String.format(
                  java.util.Locale.ROOT,
                  " · %.2f GiB archive",
                  offer.optDouble("bytes") / (1024 * 1024 * 1024));
      if (rootOf(offer).equals(pendingRoot)) current = n;
    }
    new AlertDialog.Builder(this)
        .setTitle("Hosted maps · " + address.getText())
        .setSingleChoiceItems(
            names,
            current,
            (dialog, n) -> {
              selectMap(offers.optJSONObject(n));
              dialog.dismiss();
            })
        .setNegativeButton("Close", null)
        .show();
  }

  private JSONObject displaySettings(JSONObject offer) {
    try {
      return new JSONObject(getPreferences(0).getString("display:" + rootOf(offer), "{}"));
    } catch (JSONException e) {
      return new JSONObject();
    }
  }

  private void chooseLayers() {
    if (selected == null) return;
    JSONObject offer = selected,
        m = offer.optJSONObject("manifest"),
        values = displaySettings(offer);
    java.util.ArrayList<String> keys = new java.util.ArrayList<>(),
        labels = new java.util.ArrayList<>();
    JSONArray geometry = m.optJSONArray("tileLayers"), rasters = m.optJSONArray("rasters");
    if (geometry == null)
      geometry =
          new JSONArray(
              java.util.Arrays.asList("land", "water", "buildings", "roads", "railways", "peaks"));
    if (geometry != null)
      for (int n = 0; n < geometry.length(); n++) {
        String key = geometry.optString(n);
        keys.add(key);
        switch (key) {
          case "land":
            labels.add("Landscape");
            break;
          case "water":
            labels.add("Water & sea");
            break;
          case "roads":
            labels.add("Roads & paths");
            break;
          case "buildings":
            labels.add("Buildings");
            break;
          case "railways":
            labels.add("Railways");
            break;
          case "peaks":
            labels.add("Mountain geometry");
            break;
          default:
            labels.add(key);
        }
      }
    if (rasters != null)
      for (int n = 0; n < rasters.length(); n++) {
        JSONObject raster = rasters.optJSONObject(n);
        keys.add("raster:" + raster.optString("id"));
        labels.add(raster.optString("name", "Imagery"));
      }
    boolean[] checked = new boolean[keys.size()];
    for (int n = 0; n < checked.length; n++) checked[n] = values.optBoolean(keys.get(n), true);
    new AlertDialog.Builder(this)
        .setTitle("Display layers · " + mapName(offer))
        .setMultiChoiceItems(
            labels.toArray(new String[0]), checked, (d, n, value) -> checked[n] = value)
        .setPositiveButton(
            "Apply",
            (d, w) -> {
              try {
                for (int n = 0; n < keys.size(); n++) values.put(keys.get(n), checked[n]);
                getPreferences(0)
                    .edit()
                    .putString("display:" + rootOf(offer), values.toString())
                    .apply();
                if (selected != null && rootOf(selected).equals(rootOf(offer)))
                  web.evaluateJavascript("window.setAtlasDisplay(" + values + ")", null);
                Log.i("AtlasNative", "display root=" + rootOf(offer) + " layers=" + values);
              } catch (JSONException e) {
                status.setText("Could not update layers");
              }
            })
        .setNegativeButton("Cancel", null)
        .show();
  }

  private void openSelected() {
    if (pageReady && active && selected != null)
      web.evaluateJavascript(
          "window.openAtlas(" + selected.toString() + "," + displaySettings(selected) + ")", null);
  }

  @android.annotation.SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  private void createWeb() {
    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setBlockNetworkLoads(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setAllowFileAccessFromFileURLs(false);
    s.setAllowUniversalAccessFromFileURLs(false);
    s.setDomStorageEnabled(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setJavaScriptCanOpenWindowsAutomatically(false);
    s.setSupportMultipleWindows(false);
    s.setMediaPlaybackRequiresUserGesture(true);
    CookieManager.getInstance().setAcceptCookie(false);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    // Also deny service-worker requests. No remote document or asset is ever loaded.
    ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setBlockNetworkLoads(true);
    ServiceWorkerController.getInstance()
        .setServiceWorkerClient(
            new ServiceWorkerClient() {
              @Override
              public WebResourceResponse shouldInterceptRequest(WebResourceRequest r) {
                return denied();
              }
            });
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            return true;
          }

          @Override
          public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            if (r.isForMainFrame()
                && r.getMethod().equals("GET")
                && r.getUrl().toString().equals("https://atlas.invalid/viewer")) {
              try {
                return new WebResourceResponse(
                    "text/html", "UTF-8", getAssets().open("viewer.html"));
              } catch (Exception e) {
                return denied();
              }
            }
            return denied();
          }

          @Override
          public void onPageFinished(WebView v, String url) {
            if (url.equals("https://atlas.invalid/viewer")) {
              pageReady = true;
              openSelected();
            }
          }

          @Override
          public void onReceivedSslError(
              WebView v, android.webkit.SslErrorHandler h, android.net.http.SslError e) {
            h.cancel();
          }
        });
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage m) {
            Log.i("AtlasRenderer", m.message());
            return true;
          }
        });
    web.addJavascriptInterface(new ResourceBridge(), "AtlasResources");
    root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
    web.loadUrl("https://atlas.invalid/viewer");
  }

  private String readAsset(String name) throws java.io.IOException {
    try (java.io.InputStream in = getAssets().open(name);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int n;
      while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  private static WebResourceResponse denied() {
    return new WebResourceResponse(
        "text/plain",
        "UTF-8",
        403,
        "Blocked",
        java.util.Collections.emptyMap(),
        new ByteArrayInputStream(new byte[0]));
  }

  private final class ResourceBridge {
    @JavascriptInterface
    public boolean blob(String request) {
      return active && request != null && request.length() <= 512 && nativeSubmit(request, false);
    }

    @JavascriptInterface
    public void report(String value) {
      if (!active || value == null || value.length() > 4096) return;
      runOnUiThread(
          () -> {
            if (!active) return;
            try {
              JSONObject e = new JSONObject(value);
              if (e.has("root")
                  && (selected == null || !e.optString("root").equals(rootOf(selected)))) return;
              if (e.has("error")) status.setText(e.getString("error"));
              else
                status.setText(
                    "Map · z"
                        + String.format(java.util.Locale.ROOT, "%.1f", e.optDouble("zoom"))
                        + " · "
                        + e.optInt("tiles")
                        + "/"
                        + e.optInt("wanted")
                        + " tiles · "
                        + (e.optInt("loading") == 0 ? "ready" : "loading…"));
              Log.i("AtlasRenderer", e.toString());
            } catch (JSONException ignored) {
            }
          });
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    foreground = true;
    if (web != null) web.onResume();
    if (autoConnect && hasSettings && !busy) start();
  }

  @Override
  protected void onPause() {
    foreground = false;
    lifecycleHandler.removeCallbacks(retryStart);
    if (busy) disconnect("Paused · native connection closed. Reconnect when ready.");
    if (web != null) web.onPause();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    lifecycleHandler.removeCallbacks(retryStart);
    active = false;
    nativeClose();
    if (connectivity != null && networkCallback != null)
      connectivity.unregisterNetworkCallback(networkCallback);
    if (web != null) {
      web.removeJavascriptInterface("AtlasResources");
      web.destroy();
      web = null;
    }
    worker.shutdown();
    super.onDestroy();
  }

  @Override
  protected void onSaveInstanceState(Bundle s) {
    try {
      s.putString("connection", config());
    } catch (JSONException ignored) {
    }
    super.onSaveInstanceState(s);
  }
}
