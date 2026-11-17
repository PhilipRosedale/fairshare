package social.fairshare.union;

import android.Manifest;
import android.location.Location;
import android.os.Build;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Thin Capacitor bridge with the same JS surface as the iOS plugin. All state
 * lives in {@link LocationSharingManager} so sharing keeps working when the
 * system wakes the app without a WebView.
 */
@CapacitorPlugin(
    name = "BackgroundLocation",
    permissions = {
        @Permission(
            alias = BackgroundLocationPlugin.LOCATION,
            strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
        ),
        @Permission(
            alias = BackgroundLocationPlugin.BACKGROUND_LOCATION,
            strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
        )
    }
)
public class BackgroundLocationPlugin extends Plugin {

    static final String LOCATION = "location";
    static final String BACKGROUND_LOCATION = "backgroundLocation";

    /** Max age of a cached fix before getCurrentPosition asks for a new one. */
    private static final long CACHED_LOCATION_MAX_AGE_MS = 30_000L;

    private LocationSharingManager manager;

    @Override
    public void load() {
        manager = LocationSharingManager.get(getContext());
        manager.setPlugin(this);
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null) manager.setPlugin(null);
    }

    @PluginMethod
    public void start(PluginCall call) {
        boolean ok = manager.updateConfig(
            call.getString("anonKey"),
            call.getString("uploadUrl"),
            call.getString("uploadGrant"),
            call.getString("uploadGrantExpiresAt"),
            call.getString("userId"),
            call.getString("instanceId"));
        if (!ok) {
            manager.setEnabled(false);
            call.reject("Missing Supabase location upload config");
            return;
        }
        manager.setEnabled(true);

        if (!manager.hasForegroundPermission()) {
            requestPermissionForAlias(LOCATION, call, "foregroundPermissionCallback");
            return;
        }
        continueStart(call);
    }

    @PermissionCallback
    private void foregroundPermissionCallback(PluginCall call) {
        continueStart(call);
    }

    /**
     * Android only offers "Allow all the time" as a second, separate request
     * after foreground access is granted. Ask once per sharing session.
     */
    private void continueStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && manager.hasForegroundPermission()
            && !manager.hasBackgroundPermission()
            && !manager.hasAskedBackgroundPermission()) {
            manager.setAskedBackgroundPermission(true);
            requestPermissionForAlias(BACKGROUND_LOCATION, call, "backgroundPermissionCallback");
            return;
        }
        finishStart(call);
    }

    @PermissionCallback
    private void backgroundPermissionCallback(PluginCall call) {
        finishStart(call);
    }

    private void finishStart(PluginCall call) {
        manager.startSharing();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        manager.stopSharing();
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(manager.buildStatus());
    }

    @PluginMethod
    public void getCurrentPosition(PluginCall call) {
        Location cached = manager.getLastPosition();
        if (cached != null) {
            long ageMs = (SystemClock.elapsedRealtimeNanos() - cached.getElapsedRealtimeNanos()) / 1_000_000L;
            if (ageMs < CACHED_LOCATION_MAX_AGE_MS) {
                call.resolve(toJs(cached));
                return;
            }
        }
        if (!manager.hasForegroundPermission()) {
            requestPermissionForAlias(LOCATION, call, "currentPositionPermissionCallback");
            return;
        }
        resolveWithFreshFix(call);
    }

    @PermissionCallback
    private void currentPositionPermissionCallback(PluginCall call) {
        if (!manager.hasForegroundPermission()) {
            // Same as iOS: an empty payload means "no fix", not an error.
            call.resolve(new JSObject());
            return;
        }
        resolveWithFreshFix(call);
    }

    private void resolveWithFreshFix(PluginCall call) {
        manager.requestFix("getCurrentPosition", true, location -> {
            if (location == null) {
                call.resolve(new JSObject());
                return;
            }
            manager.handleLocation(location, null);
            call.resolve(toJs(location));
        });
    }

    void emitLocationUpdate(Location location) {
        notifyListeners("locationUpdate", toJs(location));
    }

    private static JSObject toJs(Location location) {
        JSObject data = new JSObject();
        data.put("lat", location.getLatitude());
        data.put("lng", location.getLongitude());
        return data;
    }
}
