package social.fairshare.union;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Receives the background wakes for location sharing: passive location
 * updates, geofence exits, and boot / app update (when the system has dropped
 * our registrations). The work is handed to {@link LocationSharingManager}.
 */
public class LocationWakeReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pendingResult = goAsync();
        try {
            LocationSharingManager.get(context).handleWake(intent, pendingResult::finish);
        } catch (RuntimeException e) {
            android.util.Log.w(LocationSharingManager.TAG, "wake failed: " + e.getMessage());
            pendingResult.finish();
        }
    }
}
