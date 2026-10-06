const APP_TIMING = Object.freeze({
    SECOND_MS: 1000,
    MINUTE_MS: 60 * 1000,
    HOUR_MS: 60 * 60 * 1000,
    DAY_MS: 24 * 60 * 60 * 1000,
    WEEK_MS: 7 * 24 * 60 * 60 * 1000,

    FOREGROUND_LOCATION_POLL_MS: 60 * 1000,
    INBOUND_LOCATION_POLL_MS: 60 * 1000,
    SHARE_REMAINING_REFRESH_MS: 60 * 1000,

    TOAST_MS: 4000,
    SIGN_OUT_TIMEOUT_MS: 3000,
    HEARTBEAT_TIMEOUT_MS: 10 * 1000,
    CONTACT_SELFIE_DEDUPE_MS: 15 * 1000,
    CONFETTI_CLEANUP_MS: 1700,
    BROWSER_GPS_TIMEOUT_MS: 6000,
    BROWSER_GPS_MAX_AGE_MS: 60 * 1000,
    NATIVE_GPS_CACHE_MAX_AGE_MS: 30 * 1000,
    // For non-critical UX (e.g. computing "X miles away" on the contact
    // details Sharing-Location card) where ~0.1mi error from a slightly stale
    // fix is invisible. Avoids stalling the UI for up to 12s on the native
    // freshFixDeadline whenever the strict 30s cache has lapsed.
    RELAXED_GPS_MAX_AGE_MS: 5 * 60 * 1000,

    MAP_INVALIDATE_SHORT_MS: 100,
    MAP_INVALIDATE_MEDIUM_MS: 200,
    MAP_INVALIDATE_LONG_MS: 400
});

const LOCATION_DURATIONS = Object.freeze({
    HOUR_MS: APP_TIMING.HOUR_MS,
    DAY_MS: APP_TIMING.DAY_MS,
    WEEK_MS: APP_TIMING.WEEK_MS
});

const BETA_IOS_TESTFLIGHT_URL = 'https://testflight.apple.com/join/naW7xwrX';

const APP_MAP = Object.freeze({
    TILE_URL: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_4c3c_1_cc4e7e047c9f0603e396c06d',
    TILE_SUBDOMAINS: 'abcd',
    MAX_ZOOM: 20,
    CONTACT_LOCATION_MINI_ZOOM: 14,
    CONTACT_LOCATION_FULLSCREEN_ZOOM: 15,
    LOCATION_PREVIEW_ZOOM: 15
});
