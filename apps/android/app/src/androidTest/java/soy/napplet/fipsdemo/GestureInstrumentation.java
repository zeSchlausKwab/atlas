package soy.napplet.fipsdemo;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.*;
import android.view.*;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** On-device pan + genuine two-pointer pinch; no production test hooks. */
public final class GestureInstrumentation extends Instrumentation {
  @Override
  public void onCreate(Bundle args) {
    super.onCreate(args);
    start();
  }

  @Override
  public void onStart() {
    Bundle result = new Bundle();
    try {
      Intent intent =
          new Intent(getTargetContext(), AtlasActivity.class)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      Activity activity = startActivitySync(intent);
      long deadline = SystemClock.uptimeMillis() + 30000;
      AtomicBoolean ready = new AtomicBoolean(false);
      while (!ready.get() && SystemClock.uptimeMillis() < deadline) {
        runOnMainSync(() -> ready.set(hasReady(activity.getWindow().getDecorView())));
        if (!ready.get()) SystemClock.sleep(50);
      }
      if (!ready.get()) throw new Exception("Map did not finish loading before gesture test");
      String initial = readyText(activity);
      double initialZoom = zoom(initial);
      int w = getTargetContext().getResources().getDisplayMetrics().widthPixels,
          h = getTargetContext().getResources().getDisplayMetrics().heightPixels;
      long down = SystemClock.uptimeMillis();
      for (int n = 0; n <= 12; n++) {
        int action =
            n == 0
                ? MotionEvent.ACTION_DOWN
                : n == 12 ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
        MotionEvent e =
            MotionEvent.obtain(
                down, SystemClock.uptimeMillis(), action, w * .5f + n * w * .01f, h * .6f, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        if (!getUiAutomation().injectInputEvent(e, true))
          throw new Exception("Pan injection rejected");
        e.recycle();
      }
      down = SystemClock.uptimeMillis();
      send(down, MotionEvent.ACTION_DOWN, 1, w, h, .08f);
      send(
          down,
          MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
          2,
          w,
          h,
          .08f);
      for (int n = 1; n <= 20; n++) send(down, MotionEvent.ACTION_MOVE, 2, w, h, .08f + n * .008f);
      send(
          down,
          MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT),
          2,
          w,
          h,
          .24f);
      send(down, MotionEvent.ACTION_UP, 1, w, h, .24f);
      deadline = SystemClock.uptimeMillis() + 40000;
      String after = "";
      while (SystemClock.uptimeMillis() < deadline) {
        after = readyText(activity);
        if (!after.isEmpty() && zoom(after) > initialZoom + .3) break;
        SystemClock.sleep(50);
      }
      if (after.isEmpty() || zoom(after) <= initialZoom + .3)
        throw new Exception("Pinch did not zoom and finish loading: " + after);
      try (FileOutputStream out =
          new FileOutputStream(new File(getTargetContext().getFilesDir(), "gesture.png"))) {
        Bitmap shot = getUiAutomation().takeScreenshot();
        if (shot == null) throw new Exception("Screenshot unavailable");
        shot.compress(Bitmap.CompressFormat.PNG, 100, out);
        shot.recycle();
      }
      result.putString("before", initial);
      result.putString("after", after);
      result.putString("pid", Integer.toString(android.os.Process.myPid()));
      result.putString(
          "result",
          "PASS native touch pan and two-pointer pinch, zoom increased and map finished loading");
      finish(Activity.RESULT_OK, result);
    } catch (Exception e) {
      result.putString("error", e.toString());
      finish(Activity.RESULT_CANCELED, result);
    }
  }

  private double zoom(String text) {
    return Double.parseDouble(text.split("z", 2)[1].split(" · ")[0]);
  }

  private String readyText(Activity activity) {
    AtomicReference<String> text = new AtomicReference<>("");
    runOnMainSync(() -> text.set(findReady(activity.getWindow().getDecorView())));
    return text.get();
  }

  private String findReady(View v) {
    if (v instanceof TextView) {
      String s = ((TextView) v).getText().toString();
      if (s.startsWith("Map · z") && s.endsWith("ready")) return s;
    }
    if (v instanceof ViewGroup) {
      ViewGroup g = (ViewGroup) v;
      for (int i = 0; i < g.getChildCount(); i++) {
        String s = findReady(g.getChildAt(i));
        if (!s.isEmpty()) return s;
      }
    }
    return "";
  }

  private boolean hasReady(View v) {
    if (v instanceof TextView) {
      String s = ((TextView) v).getText().toString();
      if (s.startsWith("Map · z") && s.endsWith("ready")) return true;
    }
    if (v instanceof ViewGroup) {
      ViewGroup g = (ViewGroup) v;
      for (int i = 0; i < g.getChildCount(); i++) if (hasReady(g.getChildAt(i))) return true;
    }
    return false;
  }

  private void send(long down, int action, int count, int w, int h, float distance)
      throws Exception {
    MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
    MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
    for (int i = 0; i < count; i++) {
      properties[i] = new MotionEvent.PointerProperties();
      properties[i].id = i;
      properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
      coords[i] = new MotionEvent.PointerCoords();
      coords[i].x = w * (.5f + (i == 0 ? -distance : distance));
      coords[i].y = h * .6f;
      coords[i].pressure = 1;
      coords[i].size = 1;
    }
    MotionEvent e =
        MotionEvent.obtain(
            down,
            SystemClock.uptimeMillis(),
            action,
            count,
            properties,
            coords,
            0,
            0,
            1,
            1,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0);
    boolean ok = getUiAutomation().injectInputEvent(e, true);
    e.recycle();
    if (!ok) throw new Exception("Pinch injection rejected");
  }
}
