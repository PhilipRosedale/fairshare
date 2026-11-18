package social.fairshare.union;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingEvent;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/**
 * Live location sharing for Android, mirroring the iOS LocationSharingService:
 * no continuous GPS and no foreground service notification. While sharing, the
 * fused location provider delivers low-power, displacement-filtered updates to
 * {@link LocationWakeReceiver}, and a small geofence around the last fix wakes
 * the app when the device leaves it. Each wake uploads one fix to Supabase.
 *
 * Everything needed to upload lives in SharedPreferences, because wakes arrive
 * in a fresh process with no WebView and no Capacitor plugin.
 */
final class LocationSharingManager {

    static final String TAG = "BackgroundLocation";
    static final String ACTION_LOCATION = "social.fairshare.union.LOCATION_UPDATE";
    static final String ACTION_GEOFENCE = "social.fairshare.union.GEOFENCE_EVENT";

    private static final String PREFS = "union_background_location";
    private static final String KEY_ENABLED = "sharingActive";
    private static final String KEY_ANON_KEY = "anonKey";
    private static final String KEY_UPLOAD_URL = "uploadUrl";
    private static final String KEY_UPLOAD_GRANT = "uploadGrant";
    private static final String KEY_GRANT_EXPIRES = "uploadGrantExpiresAt";
    private static final String KEY_USER_ID = "userId";
    private static final String KEY_INSTANCE_ID = "instanceId";
    private static final String KEY_ASKED_BACKGROUND = "askedBackgroundPermission";
    private static final String KEY_GEOFENCE_SET = "geofenceSet";
    private static final String KEY_GEOFENCE_LAT = "geofenceLat";
    private static final String KEY_GEOFENCE_LNG = "geofenceLng";
    private static final String KEY_GEOFENCE_ACC = "geofenceAcc";
    private static final String KEY_UPLOADED_SET = "uploadedSet";
    private static final String KEY_UPLOADED_LAT = "uploadedLat";
    private static final String KEY_UPLOADED_LNG = "uploadedLng";
    private static final String KEY_UPLOADED_AT = "uploadedAt";
    private static final String KEY_PENDING_SET = "pendingSet";
    private static final String KEY_PENDING_LAT = "pendingLat";
    private static final String KEY_PENDING_LNG = "pendingLng";
    private static final String KEY_PENDING_TIME = "pendingTime";
    private static final String KEY_LAST_UPLOAD_AT = "lastUploadAt";
    private static final String KEY_LAST_UPLOAD_STATUS = "lastUploadHttpStatus";
    private static final String KEY_LAST_UPLOAD_ERROR = "lastUploadErrorSnippet";
    private static final String KEY_LAST_WAKE_AT = "lastWakeAt";
    private static final String KEY_LAST_WAKE_REASON = "lastWakeReason";
    private static final String KEY_LAST_FIX_AT = "lastDidUpdateAt";

    private static final String GEOFENCE_ID = "union.locationSharing.geofence";

    // Tuning values match the iOS plugin where the platforms allow it.
    /** Fixes older than this are cached replays, not live positions. */
    private static final long ACCEPTED_FIX_MAX_AGE_MS = 60_000L;
    /** Minimum time between uploads unless the device moved MOVEMENT_UPLOAD_THRESHOLD_M. */
    private static final long MINIMUM_UPLOAD_INTERVAL_MS = 60_000L;
    private static final float MOVEMENT_UPLOAD_THRESHOLD_M = 10f;
    /** Low-power fixes are cell/Wi-Fi based; coarser than this gets one GPS follow-up. */
    private static final float REFINE_ACCURACY_THRESHOLD_M = 100f;
    /** Rate limit for follow-up fixes so a run of poor fixes cannot keep GPS on. */
    private static final long MINIMUM_FIX_REQUEST_INTERVAL_MS = 20_000L;
    private static final float GEOFENCE_RADIUS_M = 150f;
    private static final float GEOFENCE_RECENTER_THRESHOLD_M = 25f;
    /** Passive update cadence. Android throttles background delivery further. */
    private static final long PASSIVE_INTERVAL_MS = 5 * 60_000L;
    private static final long PASSIVE_FASTEST_INTERVAL_MS = 60_000L;
    private static final float PASSIVE_MIN_DISTANCE_M = 100f;
    private static final long ONE_SHOT_FIX_TIMEOUT_MS = 12_000L;
    private static final long UPLOAD_RETRY_DELAY_MS = 15_000L;
    /** A broadcast wake must finish well inside the system's receiver limit. */
    private static final long WAKE_WINDOW_MS = 25_000L;
    private static final int HTTP_TIMEOUT_MS = 10_000;

    interface FixCallback {
        void onFix(Location location);
    }

    private static LocationSharingManager instance;

    static synchronized LocationSharingManager get(Context context) {
        if (instance == null) {
            instance = new LocationSharingManager(context.getApplicationContext());
        }
        return instance;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final FusedLocationProviderClient fused;
    private final GeofencingClient geofencing;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();

    private volatile BackgroundLocationPlugin plugin;
    private volatile Location lastPosition;
    private long lastFixRequestAt;
    private boolean passiveUpdatesActive;
    private final AtomicBoolean uploadRetryScheduled = new AtomicBoolean(false);

    private LocationSharingManager(Context appContext) {
        context = appContext;
        prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        fused = LocationServices.getFusedLocationProviderClient(appContext);
        geofencing = LocationServices.getGeofencingClient(appContext);
    }

    void setPlugin(BackgroundLocationPlugin plugin) {
        this.plugin = plugin;
    }

    Location getLastPosition() {
        return lastPosition;
    }

    // ---- Config and state -------------------------------------------------

    boolean updateConfig(String anonKey, String uploadUrl, String uploadGrant,
                         String uploadGrantExpiresAt, String userId, String instanceId) {
        if (isEmpty(anonKey) || isEmpty(uploadUrl) || isEmpty(uploadGrant) || isEmpty(userId)) {
            return false;
        }
        prefs.edit()
            .putString(KEY_ANON_KEY, anonKey)
            .putString(KEY_UPLOAD_URL, uploadUrl)
            .putString(KEY_UPLOAD_GRANT, uploadGrant)
            .putString(KEY_GRANT_EXPIRES, uploadGrantExpiresAt)
            .putString(KEY_USER_ID, userId)
            .putString(KEY_INSTANCE_ID, instanceId)
            .apply();
        Log.i(TAG, "updated Supabase config user=" + redact(userId) + " instance=" + redact(instanceId));
        return true;
    }

    boolean hasConfig() {
        return !isEmpty(prefs.getString(KEY_UPLOAD_URL, null))
            && !isEmpty(prefs.getString(KEY_UPLOAD_GRANT, null))
            && !isEmpty(prefs.getString(KEY_ANON_KEY, null));
    }

    boolean isEnabled() {
        return prefs.getBoolean(KEY_ENABLED, false);
    }

    void setEnabled(boolean enabled) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    boolean hasAskedBackgroundPermission() {
        return prefs.getBoolean(KEY_ASKED_BACKGROUND, false);
    }

    void setAskedBackgroundPermission(boolean asked) {
        prefs.edit().putBoolean(KEY_ASKED_BACKGROUND, asked).apply();
    }

    boolean hasForegroundPermission() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION)
            || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    boolean hasBackgroundPermission() {
        if (!hasForegroundPermission()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    // ---- Start / stop -----------------------------------------------------

    /** Arm passive updates and take one fix now. Safe to call repeatedly. */
    void startSharing() {
        armPassiveMonitoring();
        requestFix("start", true, location -> {
            if (location != null) handleLocation(location, null);
        });
        retryPendingUpload();
        logState("start");
    }

    void stopSharing() {
        setEnabled(false);
        setAskedBackgroundPermission(false);
        clearPendingUpload();
        disarmPassiveMonitoring();
        logState("stop");
    }

    @SuppressLint("MissingPermission")
    private void armPassiveMonitoring() {
        if (!isEnabled() || !hasForegroundPermission()) return;
        LocationRequest request = new LocationRequest.Builder(
                Priority.PRIORITY_BALANCED_POWER_ACCURACY, PASSIVE_INTERVAL_MS)
            .setMinUpdateIntervalMillis(PASSIVE_FASTEST_INTERVAL_MS)
            .setMinUpdateDistanceMeters(PASSIVE_MIN_DISTANCE_M)
            .build();
        try {
            fused.requestLocationUpdates(request, wakeIntent(ACTION_LOCATION))
                .addOnSuccessListener(unused -> {
                    passiveUpdatesActive = true;
                    Log.i(TAG, "started passive location updates");
                })
                .addOnFailureListener(e -> Log.w(TAG, "passive location updates failed: " + e.getMessage()));
        } catch (SecurityException e) {
            Log.w(TAG, "passive location updates not permitted: " + e.getMessage());
        }
        Location last = lastPosition;
        if (last != null) refreshGeofence(last);
    }

    private void disarmPassiveMonitoring() {
        try {
            fused.removeLocationUpdates(wakeIntent(ACTION_LOCATION));
            geofencing.removeGeofences(Collections.singletonList(GEOFENCE_ID));
        } catch (RuntimeException e) {
            Log.w(TAG, "stopping passive monitoring failed: " + e.getMessage());
        }
        passiveUpdatesActive = false;
        prefs.edit().putBoolean(KEY_GEOFENCE_SET, false).apply();
        Log.i(TAG, "stopped passive location monitoring");
    }

    /**
     * Geofences need "Allow all the time" on Android 10+, so without it this is
     * a no-op and sharing only updates while the app is open.
     */
    @SuppressLint("MissingPermission")
    private void refreshGeofence(Location location) {
        if (!isEnabled() || !hasBackgroundPermission()) return;
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) return;
        if (prefs.getBoolean(KEY_GEOFENCE_SET, false)) {
            float[] distance = new float[1];
            Location.distanceBetween(
                prefs.getFloat(KEY_GEOFENCE_LAT, 0f), prefs.getFloat(KEY_GEOFENCE_LNG, 0f),
                location.getLatitude(), location.getLongitude(), distance);
            if (distance[0] < GEOFENCE_RECENTER_THRESHOLD_M
                && location.getAccuracy() >= prefs.getFloat(KEY_GEOFENCE_ACC, 0f)) {
                return;
            }
        }
        float radius = Math.max(GEOFENCE_RADIUS_M, location.getAccuracy());
        Geofence geofence = new Geofence.Builder()
            .setRequestId(GEOFENCE_ID)
            .setCircularRegion(location.getLatitude(), location.getLongitude(), radius)
            .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_EXIT)
            .setExpirationDuration(Geofence.NEVER_EXPIRE)
            .build();
        GeofencingRequest request = new GeofencingRequest.Builder()
            .setInitialTrigger(0)
            .addGeofence(geofence)
            .build();
        final double lat = location.getLatitude();
        final double lng = location.getLongitude();
        final float accuracy = location.getAccuracy();
        try {
            geofencing.addGeofences(request, wakeIntent(ACTION_GEOFENCE))
                .addOnSuccessListener(unused -> prefs.edit()
                    .putBoolean(KEY_GEOFENCE_SET, true)
                    .putFloat(KEY_GEOFENCE_LAT, (float) lat)
                    .putFloat(KEY_GEOFENCE_LNG, (float) lng)
                    .putFloat(KEY_GEOFENCE_ACC, accuracy)
                    .apply())
                .addOnFailureListener(e -> {
                    prefs.edit().putBoolean(KEY_GEOFENCE_SET, false).apply();
                    Log.w(TAG, "geofence registration failed: " + e.getMessage());
                });
        } catch (SecurityException e) {
            Log.w(TAG, "geofence registration not permitted: " + e.getMessage());
        }
    }

    private PendingIntent wakeIntent(String action) {
        Intent intent = new Intent(context, LocationWakeReceiver.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        // Play services fills the location / geofence extras in, so the intent
        // has to be mutable on Android 12+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        return PendingIntent.getBroadcast(context, 0, intent, flags);
    }

    // ---- Wakes ------------------------------------------------------------

    /**
     * Entry point for {@link LocationWakeReceiver}. {@code done} is always
     * called exactly once, either when the work finishes or when the wake
     * window runs out.
     */
    void handleWake(Intent intent, Runnable done) {
        final AtomicBoolean finished = new AtomicBoolean(false);
        final Runnable finish = () -> {
            if (finished.compareAndSet(false, true)) done.run();
        };
        mainHandler.postDelayed(finish, WAKE_WINDOW_MS);

        String action = intent == null ? null : intent.getAction();
        if (!isEnabled() || !hasConfig() || action == null) {
            finish.run();
            return;
        }

        if (ACTION_LOCATION.equals(action)) {
            LocationResult result = LocationResult.extractResult(intent);
            Location location = result == null ? null : result.getLastLocation();
            if (location == null) {
                finish.run();
                return;
            }
            recordWake("locationUpdate");
            if (location.getAccuracy() > REFINE_ACCURACY_THRESHOLD_M) {
                // Upload the coarse fix, then try once for a better one.
                handleLocation(location, () -> requestFix("refine", false, refined -> {
                    if (refined != null) {
                        handleLocation(refined, finish);
                    } else {
                        finish.run();
                    }
                }));
            } else {
                handleLocation(location, finish);
            }
        } else if (ACTION_GEOFENCE.equals(action)) {
            GeofencingEvent event = GeofencingEvent.fromIntent(intent);
            if (event == null || event.hasError()
                || event.getGeofenceTransition() != Geofence.GEOFENCE_TRANSITION_EXIT) {
                finish.run();
                return;
            }
            recordWake("geofenceExit");
            // The old fence is behind us; let the next fix lay down a new one.
            prefs.edit().putBoolean(KEY_GEOFENCE_SET, false).apply();
            Location trigger = event.getTriggeringLocation();
            requestFix("geofenceExit", true, location -> {
                Location best = location != null ? location : trigger;
                if (best != null) {
                    handleLocation(best, finish);
                } else {
                    finish.run();
                }
            });
        } else {
            // Boot or app update: location requests and geofences are cleared
            // by the system, so register them again.
            recordWake("relaunch");
            armPassiveMonitoring();
            requestFix("relaunch", true, location -> {
                if (location != null) {
                    handleLocation(location, finish);
                } else {
                    finish.run();
                }
            });
        }
    }

    /** Ask for a single fresh fix. Non-forced requests are rate limited. */
    @SuppressLint("MissingPermission")
    void requestFix(String reason, boolean force, FixCallback callback) {
        if (!hasForegroundPermission()) {
            callback.onFix(null);
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (!force && lastFixRequestAt != 0 && (now - lastFixRequestAt) < MINIMUM_FIX_REQUEST_INTERVAL_MS) {
            callback.onFix(null);
            return;
        }
        lastFixRequestAt = now;
        Log.i(TAG, "requesting fix (" + reason + ")");
        CurrentLocationRequest request = new CurrentLocationRequest.Builder()
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
            .setMaxUpdateAgeMillis(0)
            .setDurationMillis(ONE_SHOT_FIX_TIMEOUT_MS)
            .build();
        try {
            fused.getCurrentLocation(request, null)
                .addOnSuccessListener(callback::onFix)
                .addOnFailureListener(e -> {
                    Log.w(TAG, "fix request failed (" + reason + "): " + e.getMessage());
                    callback.onFix(null);
                });
        } catch (SecurityException e) {
            Log.w(TAG, "fix request not permitted: " + e.getMessage());
            callback.onFix(null);
        }
    }

    /**
     * Validate a fix, tell the WebView about it, and upload it if sharing is on
     * and it is worth uploading. {@code done} may be null.
     */
    void handleLocation(Location location, Runnable done) {
        if (!isAcceptable(location)) {
            if (done != null) done.run();
            return;
        }
        lastPosition = location;
        prefs.edit().putLong(KEY_LAST_FIX_AT, System.currentTimeMillis()).apply();
        BackgroundLocationPlugin p = plugin;
        if (p != null) p.emitLocationUpdate(location);

        if (!isEnabled()) {
            if (done != null) done.run();
            return;
        }
        refreshGeofence(location);
        if (!shouldUpload(location)) {
            if (done != null) done.run();
            return;
        }
        Log.i(TAG, "uploading fix accuracy=" + location.getAccuracy() + "m");
        enqueueUpload(location.getLatitude(), location.getLongitude(), location.getTime(), done);
    }

    private boolean isAcceptable(Location location) {
        if (location == null) return false;
        if (location.hasAccuracy() && location.getAccuracy() <= 0f) return false;
        long ageMs = (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000L;
        if (ageMs > ACCEPTED_FIX_MAX_AGE_MS) {
            Log.i(TAG, "discarding stale fix age=" + (ageMs / 1000) + "s");
            return false;
        }
        if (!BuildConfig.DEBUG && isMock(location)) {
            Log.i(TAG, "discarding mock location");
            return false;
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private boolean isMock(Location location) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return location.isMock();
        return location.isFromMockProvider();
    }

    private boolean shouldUpload(Location location) {
        if (!prefs.getBoolean(KEY_UPLOADED_SET, false)) return true;
        long sinceLast = System.currentTimeMillis() - prefs.getLong(KEY_UPLOADED_AT, 0L);
        if (sinceLast < 0 || sinceLast >= MINIMUM_UPLOAD_INTERVAL_MS) return true;
        float[] distance = new float[1];
        Location.distanceBetween(
            Double.longBitsToDouble(prefs.getLong(KEY_UPLOADED_LAT, 0L)),
            Double.longBitsToDouble(prefs.getLong(KEY_UPLOADED_LNG, 0L)),
            location.getLatitude(), location.getLongitude(), distance);
        return distance[0] >= MOVEMENT_UPLOAD_THRESHOLD_M;
    }

    // ---- Upload -----------------------------------------------------------

    private void enqueueUpload(final double lat, final double lng, final long fixTimeMs, final Runnable done) {
        uploadExecutor.execute(() -> {
            try {
                upload(lat, lng, fixTimeMs);
            } finally {
                if (done != null) mainHandler.post(done);
            }
        });
    }

    /**
     * A fix that failed to upload is retried after a short delay, like iOS. If
     * the process is gone by then, it is retried on the next wake or app open.
     */
    private void scheduleUploadRetry() {
        if (!uploadRetryScheduled.compareAndSet(false, true)) return;
        mainHandler.postDelayed(() -> {
            uploadRetryScheduled.set(false);
            retryPendingUpload();
        }, UPLOAD_RETRY_DELAY_MS);
    }

    private void retryPendingUpload() {
        if (!isEnabled() || !prefs.getBoolean(KEY_PENDING_SET, false)) return;
        enqueueUpload(
            Double.longBitsToDouble(prefs.getLong(KEY_PENDING_LAT, 0L)),
            Double.longBitsToDouble(prefs.getLong(KEY_PENDING_LNG, 0L)),
            prefs.getLong(KEY_PENDING_TIME, System.currentTimeMillis()),
            null);
    }

    private void clearPendingUpload() {
        prefs.edit().putBoolean(KEY_PENDING_SET, false).apply();
    }

    /** Runs on the upload thread. */
    private void upload(double lat, double lng, long fixTimeMs) {
        if (!isEnabled()) return;
        String uploadUrl = prefs.getString(KEY_UPLOAD_URL, null);
        String anonKey = prefs.getString(KEY_ANON_KEY, null);
        String grant = prefs.getString(KEY_UPLOAD_GRANT, null);
        if (isEmpty(uploadUrl) || isEmpty(anonKey) || isEmpty(grant)) {
            Log.w(TAG, "no Supabase config; skipping upload");
            return;
        }

        HttpURLConnection connection = null;
        int status = 0;
        String errorSnippet = null;
        try {
            // updated_at is the fix time, so viewers see how old the position
            // actually is for a sharer who has not moved.
            JSONObject body = new JSONObject();
            body.put("action", "upload");
            body.put("lat", lat);
            body.put("lng", lng);
            body.put("updated_at", isoTime(fixTimeMs));
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);

            connection = (HttpURLConnection) new URL(uploadUrl).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(HTTP_TIMEOUT_MS);
            connection.setReadTimeout(HTTP_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("apikey", anonKey);
            connection.setRequestProperty("Authorization", "Bearer " + anonKey);
            connection.setRequestProperty("X-Location-Upload-Grant", grant);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload);
            }
            status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                errorSnippet = readSnippet(connection.getErrorStream());
            }
        } catch (Exception e) {
            errorSnippet = String.valueOf(e.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }

        SharedPreferences.Editor editor = prefs.edit()
            .putLong(KEY_LAST_UPLOAD_AT, System.currentTimeMillis())
            .putInt(KEY_LAST_UPLOAD_STATUS, status)
            .putString(KEY_LAST_UPLOAD_ERROR, errorSnippet);

        if (status >= 200 && status < 300) {
            editor.putBoolean(KEY_UPLOADED_SET, true)
                .putLong(KEY_UPLOADED_LAT, Double.doubleToLongBits(lat))
                .putLong(KEY_UPLOADED_LNG, Double.doubleToLongBits(lng))
                .putLong(KEY_UPLOADED_AT, System.currentTimeMillis())
                .putBoolean(KEY_PENDING_SET, false)
                .apply();
            Log.i(TAG, "location upload succeeded");
        } else if (status == 401 || status == 403) {
            // 403: every share from this device has expired or been removed.
            // 401: the grant is invalid. Either way stop until the WebView
            // calls start() again with a fresh grant.
            editor.putBoolean(KEY_PENDING_SET, false).apply();
            Log.w(TAG, "upload grant rejected (HTTP " + status + "); stopping until the app provides a fresh grant");
            mainHandler.post(() -> {
                setEnabled(false);
                disarmPassiveMonitoring();
            });
        } else {
            editor.putBoolean(KEY_PENDING_SET, true)
                .putLong(KEY_PENDING_LAT, Double.doubleToLongBits(lat))
                .putLong(KEY_PENDING_LNG, Double.doubleToLongBits(lng))
                .putLong(KEY_PENDING_TIME, fixTimeMs)
                .apply();
            Log.w(TAG, "location upload failed status=" + status + " error=" + errorSnippet);
            scheduleUploadRetry();
        }
    }

    private static String readSnippet(InputStream stream) {
        if (stream == null) return null;
        try (InputStream in = stream) {
            byte[] buffer = new byte[200];
            int read = in.read(buffer);
            return read <= 0 ? null : new String(buffer, 0, read, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    // ---- Diagnostics ------------------------------------------------------

    private void recordWake(String reason) {
        prefs.edit()
            .putLong(KEY_LAST_WAKE_AT, System.currentTimeMillis())
            .putString(KEY_LAST_WAKE_REASON, reason)
            .apply();
        Log.i(TAG, "wake (" + reason + ")");
    }

    /** Same keys as the iOS plugin's getStatus so the JS diagnostics are shared. */
    JSObject buildStatus() {
        boolean foreground = hasForegroundPermission();
        boolean background = hasBackgroundPermission();
        JSObject status = new JSObject();
        status.put("authorizationStatus",
            background ? "authorizedAlways" : (foreground ? "authorizedWhenInUse" : "denied"));
        status.put("allowsBackgroundLocationUpdates", background && isEnabled());
        status.put("hasSupabaseConfig", hasConfig());
        status.put("hasUploadGrant", !isEmpty(prefs.getString(KEY_UPLOAD_GRANT, null)));
        status.put("configUser", redact(prefs.getString(KEY_USER_ID, null)));
        status.put("configInstance", redact(prefs.getString(KEY_INSTANCE_ID, null)));
        status.put("locationUploadEnabled", isEnabled());
        status.put("hasPendingUpload", prefs.getBoolean(KEY_PENDING_SET, false));
        status.put("passiveUpdatesActive", passiveUpdatesActive);
        status.put("geofenceActive", prefs.getBoolean(KEY_GEOFENCE_SET, false));
        putTime(status, "lastUploadAt", KEY_LAST_UPLOAD_AT);
        putTime(status, "lastWakeAt", KEY_LAST_WAKE_AT);
        putTime(status, "lastDidUpdateAt", KEY_LAST_FIX_AT);
        if (prefs.contains(KEY_LAST_UPLOAD_STATUS)) {
            status.put("lastUploadHttpStatus", prefs.getInt(KEY_LAST_UPLOAD_STATUS, 0));
        }
        String error = prefs.getString(KEY_LAST_UPLOAD_ERROR, null);
        if (error != null) status.put("lastUploadErrorSnippet", error);
        String wakeReason = prefs.getString(KEY_LAST_WAKE_REASON, null);
        if (wakeReason != null) status.put("lastWakeReason", wakeReason);
        String expires = prefs.getString(KEY_GRANT_EXPIRES, null);
        if (expires != null) status.put("uploadGrantExpiresAt", expires);
        return status;
    }

    private void putTime(JSObject status, String name, String key) {
        long value = prefs.getLong(key, 0L);
        if (value > 0) status.put(name, isoTime(value));
    }

    private void logState(String context) {
        Log.i(TAG, "state[" + context + "] " + buildStatus().toString());
    }

    private static String isoTime(long timeMs) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(timeMs));
    }

    private static boolean isEmpty(String value) {
        return value == null || value.isEmpty();
    }

    private static String redact(String value) {
        if (isEmpty(value)) return "nil";
        if (value.length() <= 12) return value;
        return value.substring(0, 6) + "..." + value.substring(value.length() - 6);
    }
}
