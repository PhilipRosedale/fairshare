package social.fairshare.union;

import android.util.Log;
import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Replaces the Capacitor push plugin's service (see AndroidManifest.xml) so
 * that data-only {@code location_refresh} messages are handled natively, even
 * when the app is closed and there is no WebView. Everything else goes to the
 * plugin as before.
 */
public class UnionMessagingService extends MessagingService {

    private static final String TYPE_LOCATION_REFRESH = "location_refresh";
    /**
     * Android allows a high-priority message about 20 s of work; the service
     * may be stopped once onMessageReceived returns, so wait for the upload here.
     */
    private static final long REFRESH_WAIT_SECONDS = 19;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        if (TYPE_LOCATION_REFRESH.equals(remoteMessage.getData().get("type"))) {
            handleLocationRefresh();
            return;
        }
        super.onMessageReceived(remoteMessage);
    }

    /** Runs on Firebase's worker thread, so blocking here is fine. */
    private void handleLocationRefresh() {
        CountDownLatch done = new CountDownLatch(1);
        try {
            LocationSharingManager.get(this).handleRefreshRequest(done::countDown);
            if (!done.await(REFRESH_WAIT_SECONDS, TimeUnit.SECONDS)) {
                Log.w(LocationSharingManager.TAG, "refresh request did not finish in time");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            Log.w(LocationSharingManager.TAG, "refresh request failed: " + e.getMessage());
        }
    }
}
