package social.fairshare.union;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge is created.
        registerPlugin(BackgroundLocationPlugin.class);
        super.onCreate(savedInstanceState);
        scheduleInjectAndroidFcmFlag();
    }

    @Override
    public void onStart() {
        super.onStart();
        scheduleInjectAndroidFcmFlag();
    }

    /**
     * Capacitor PushNotifications on Android calls FirebaseMessaging.getInstance(),
     * which crashes if {@code google-services.json} is missing. The web layer
     * reads {@code window.__UNION_ANDROID_FCM__} to avoid calling register() until
     * Firebase is configured.
     */
    private void scheduleInjectAndroidFcmFlag() {
        injectAndroidFcmFlag();
        // Bridge/WebView are often null in onCreate; retry after Capacitor loads.
        mainHandler.postDelayed(this::injectAndroidFcmFlag, 300);
        mainHandler.postDelayed(this::injectAndroidFcmFlag, 1000);
    }

    private void injectAndroidFcmFlag() {
        boolean enabled = BuildConfig.HAS_GOOGLE_SERVICES;
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        String js = "window.__UNION_ANDROID_FCM__=" + (enabled ? "true" : "false") + ";";
        bridge.getWebView().post(() -> bridge.getWebView().evaluateJavascript(js, null));
    }
}
