package soy.napplet.fipsdemo;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** A foreground-only native socket experiment. Contains no WebView or browser bridge. */
public final class MainActivity extends Activity {
  static {
    System.loadLibrary("soy_fips_demo");
  }

  private native boolean nativePrepare();

  private native String nativeFetch(String json);

  private native void nativeCancel();

  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final int ink = Color.rgb(237, 247, 243),
      muted = Color.rgb(160, 186, 178),
      accent = Color.rgb(133, 232, 196);
  private EditText address, peer, hash;
  private RadioGroup transport;
  private Button connect, paste;
  private TextView status, detail, result;
  private ProgressBar progress;
  private boolean busy = false, stopped = false;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.rgb(13, 27, 25));
    getWindow().setNavigationBarColor(Color.rgb(13, 27, 25));
    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(Color.rgb(13, 27, 25));
    scroll.setFillViewport(true);
    LinearLayout root = column();
    root.setPadding(dp(24), dp(18), dp(24), dp(24));
    scroll.addView(root);
    scroll.setOnApplyWindowInsetsListener(
        (v, insets) -> {
          android.graphics.Insets i =
              insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
          v.setPadding(i.left, i.top, i.right, i.bottom);
          return insets;
        });
    root.addView(label("SOYTEC  /  TRANSPORT LAB", 12, accent));
    TextView title = label("Native FIPS", 34, ink);
    title.setTypeface(null, Typeface.BOLD);
    gap(root, title, 12);
    gap(
        root,
        label(
            "A direct connection from your phone.\nAuthenticated peer. Verified content.",
            16,
            muted),
        4);

    LinearLayout card = column();
    card.setPadding(dp(18), dp(18), dp(18), dp(18));
    card.setBackground(shape(Color.rgb(25, 45, 41), 18));
    gap(root, card, 24);
    card.addView(label("PHYSICAL TRANSPORT", 11, muted));
    transport = new RadioGroup(this);
    transport.setOrientation(RadioGroup.HORIZONTAL);
    for (int n = 0; n < 2; n++) {
      RadioButton b = new RadioButton(this);
      b.setId(n == 0 ? R.id.udp : R.id.tcp);
      b.setText(n == 0 ? "UDP" : "TCP");
      b.setTextColor(ink);
      b.setButtonTintList(ColorStateList.valueOf(accent));
      transport.addView(b, new RadioGroup.LayoutParams(0, dp(48), 1));
    }
    transport.check(R.id.udp);
    card.addView(transport);
    address = field(card, "Peer address", "10.0.2.2:42121");
    peer = field(card, "Peer identity · npub", "Paste the fixture’s public identity");
    hash = field(card, "Resource · SHA-256", "64-character content hash");
    paste = new Button(this);
    paste.setText("Paste connection details");
    paste.setTextColor(accent);
    paste.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(39, 65, 58)));
    gap(card, paste, 12);
    paste.setOnClickListener(v -> importDialog());

    connect = new Button(this);
    connect.setText("Connect & verify");
    connect.setAllCaps(false);
    connect.setTextSize(17);
    connect.setTextColor(Color.rgb(13, 27, 25));
    connect.setBackgroundTintList(ColorStateList.valueOf(accent));
    gap(root, connect, 20);
    connect.setOnClickListener(
        v -> {
          if (busy) {
            nativeCancel();
            status.setText("Closing connection…");
            connect.setEnabled(false);
          } else start();
        });
    progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progress.setIndeterminateTintList(ColorStateList.valueOf(accent));
    progress.setProgressTintList(ColorStateList.valueOf(accent));
    progress.setVisibility(View.GONE);
    gap(root, progress, 14);
    status = label("Ready when you are", 19, ink);
    status.setTypeface(null, Typeface.BOLD);
    gap(root, status, 18);
    detail =
        label(
            "Start the companion peer, then paste its connection details. Use a numeric IP address;"
                + " no DNS lookup is needed.",
            14,
            muted);
    gap(root, detail, 8);
    result = label("", 13, muted);
    result.setTextIsSelectable(true);
    gap(root, result, 12);
    gap(
        root,
        label(
            "NATIVE SOCKETS  ·  NO WEBVIEW\n"
                + "No WebSocket, STUN/TURN or VPN. Connections close when you leave this screen."
                + " This demo fetches one public blob, not the Atlas map.",
            12,
            muted),
        24);
    setContentView(scroll);
    if (state != null) {
      address.setText(state.getString("address", ""));
      peer.setText(state.getString("peer", ""));
      hash.setText(state.getString("hash", ""));
      transport.check(state.getInt("transport", R.id.udp));
    } else applyIntent(getIntent());
  }

  private LinearLayout column() {
    LinearLayout v = new LinearLayout(this);
    v.setOrientation(LinearLayout.VERTICAL);
    return v;
  }

  private TextView label(String s, int size, int color) {
    TextView v = new TextView(this);
    v.setText(s);
    v.setTextSize(size);
    v.setTextColor(color);
    v.setLineSpacing(dp(3), 1);
    return v;
  }

  private int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  private GradientDrawable shape(int color, int radius) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(dp(radius));
    return d;
  }

  private void gap(LinearLayout parent, View child, int margin) {
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.topMargin = dp(margin);
    parent.addView(child, p);
  }

  private EditText field(LinearLayout parent, String caption, String hint) {
    TextView label = label(caption, 13, muted);
    gap(parent, label, 12);
    EditText v = new EditText(this);
    v.setId(View.generateViewId());
    label.setLabelFor(v.getId());
    v.setHint(hint);
    v.setTextSize(14);
    v.setTextColor(ink);
    v.setHintTextColor(muted);
    v.setSingleLine(true);
    v.setSelectAllOnFocus(true);
    v.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    v.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
    v.setMinimumHeight(dp(48));
    parent.addView(v, new LinearLayout.LayoutParams(-1, -2));
    return v;
  }

  private void importDialog() {
    EditText input = new EditText(this);
    input.setHint("Paste the JSON printed by fips-demo serve");
    input.setMinLines(4);
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
    new AlertDialog.Builder(this)
        .setTitle("Connection details")
        .setMessage("Only public peer details are needed. Never paste private keys.")
        .setView(input)
        .setPositiveButton(
            "Use details",
            (d, w) -> {
              try {
                applyConfig(input.getText().toString());
              } catch (Exception e) {
                status.setText("Check the connection details");
                detail.setText(e.getMessage());
              }
            })
        .setNegativeButton("Cancel", null)
        .show();
  }

  private void applyConfig(String text) throws Exception {
    if (text.length() > 4096) throw new Exception("Connection details are too long");
    JSONObject c = new JSONObject(text);
    String t = c.getString("transport");
    if (!t.equals("tcp") && !t.equals("udp")) throw new Exception("Choose tcp or udp");
    String a = c.getString("address"), p = c.getString("peer"), h = c.getString("hash");
    transport.check(t.equals("tcp") ? R.id.tcp : R.id.udp);
    address.setText(a);
    peer.setText(p);
    hash.setText(h);
    status.setText("Peer details loaded");
    detail.setText("Connect to authenticate this peer and verify its content.");
  }

  private void applyIntent(Intent intent) {
    String config = intent.getStringExtra("config");
    if (config != null)
      try {
        applyConfig(config);
      } catch (Exception e) {
        status.setText("Invalid connection details");
        detail.setText(e.getMessage());
      }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (!busy) applyIntent(intent);
  }

  private void start() {
    try {
      JSONObject c = new JSONObject();
      c.put("transport", transport.getCheckedRadioButtonId() == R.id.tcp ? "tcp" : "udp");
      c.put("address", address.getText().toString().trim());
      c.put("peer", peer.getText().toString().trim());
      c.put("hash", hash.getText().toString().trim());
      if (!nativePrepare()) {
        status.setText("Finishing the previous connection");
        detail.setText("Please try again in a moment.");
        return;
      }
      ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
          .hideSoftInputFromWindow(address.getWindowToken(), 0);
      setBusy(true);
      result.setText("");
      progress.setIndeterminate(true);
      progress.setVisibility(View.VISIBLE);
      status.setText("Starting native FIPS…");
      worker.execute(
          () -> {
            String response = nativeFetch(c.toString());
            runOnUiThread(
                () -> {
                  if (isDestroyed()) return;
                  render(response);
                  setBusy(false);
                });
          });
    } catch (Exception e) {
      status.setText("Could not start");
      detail.setText(e.getMessage());
    }
  }

  private void setBusy(boolean running) {
    busy = running;
    connect.setEnabled(true);
    connect.setText(running ? "Cancel transfer" : "Connect & verify");
    paste.setEnabled(!running);
    address.setEnabled(!running);
    peer.setEnabled(!running);
    hash.setEnabled(!running);
    for (int i = 0; i < transport.getChildCount(); i++)
      transport.getChildAt(i).setEnabled(!running);
  }

  /** Called only on the Java worker that entered JNI, never on a Rust-owned thread. */
  public void onNativeProgress(String json) {
    runOnUiThread(
        () -> {
          if (!isDestroyed() && !stopped) render(json);
        });
  }

  private void render(String json) {
    try {
      JSONObject e = new JSONObject(json);
      String stage = e.getString("stage");
      status.setText(e.getString("message"));
      Log.i(
          "NativeFipsDemo",
          stage + " carrier=" + e.optString("carrier") + " bytes=" + e.optInt("bytes"));
      if (e.has("local")) detail.setText("Fresh local identity\n" + e.getString("local"));
      if (stage.equals("connected"))
        detail.setText("Peer authenticated · Hashtree service 39018\n" + e.getString("peer"));
      if (stage.equals("receiving")) {
        progress.setIndeterminate(false);
        progress.setMax(e.getInt("total"));
        progress.setProgress(e.getInt("received"));
      }
      if (stage.equals("complete")) {
        progress.setIndeterminate(false);
        progress.setMax(100);
        progress.setProgress(100);
        detail.setText(
            e.getString("carrier").toUpperCase(java.util.Locale.ROOT)
                + " · "
                + String.format(java.util.Locale.ROOT, "%,d", e.getInt("bytes"))
                + " verified bytes · "
                + e.getLong("elapsed_ms")
                + " ms\nSHA-256 "
                + e.getString("hash"));
        result.setText(e.getString("preview"));
      }
      if (stage.equals("error") || stage.equals("cancelled")) {
        progress.setVisibility(View.GONE);
        status.setText(
            stage.equals("cancelled") ? "Transfer cancelled" : "Connection needs attention");
        detail.setText(e.getString("message"));
      }
    } catch (Exception e) {
      progress.setVisibility(View.GONE);
      status.setText("Could not read native result");
      detail.setText("Retry the connection.");
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    stopped = false;
  }

  @Override
  protected void onPause() {
    stopped = true;
    if (busy) nativeCancel();
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    if (busy) nativeCancel();
    worker.shutdown();
    super.onDestroy();
  }

  @Override
  protected void onSaveInstanceState(Bundle s) {
    s.putString("address", address.getText().toString());
    s.putString("peer", peer.getText().toString());
    s.putString("hash", hash.getText().toString());
    s.putInt("transport", transport.getCheckedRadioButtonId());
    super.onSaveInstanceState(s);
  }
}
