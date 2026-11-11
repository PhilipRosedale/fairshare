import Foundation
import Capacitor
import CoreLocation
import UIKit

/// Thin Capacitor bridge. All Core Location state lives in
/// `LocationSharingService` so it survives background relaunches, which happen
/// before (or without) the WebView and its plugins being created.
@objc(BackgroundLocationPlugin)
public class BackgroundLocationPlugin: CAPPlugin {
    public override func load() {
        LocationSharingService.shared.plugin = self
    }

    @objc func start(_ call: CAPPluginCall) {
        LocationSharingService.shared.start(call)
    }

    @objc func stop(_ call: CAPPluginCall) {
        LocationSharingService.shared.stop(call)
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        LocationSharingService.shared.getStatus(call)
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        LocationSharingService.shared.getCurrentPosition(call)
    }

    func emitLocationUpdate(_ location: CLLocation) {
        notifyListeners("locationUpdate", data: [
            "lat": location.coordinate.latitude,
            "lng": location.coordinate.longitude
        ])
    }
}

/// Live location sharing modelled on Find My: no continuous GPS. While sharing,
/// iOS wakes (or relaunches) the app for significant location changes, visits,
/// and exits from a small geofence around the last fix; each wake takes one
/// `requestLocation()` fix and uploads it. None of these show the blue
/// background-location pill, and GPS stays off while the device is stationary.
final class LocationSharingService: NSObject, CLLocationManagerDelegate {
    static let shared = LocationSharingService()

    weak var plugin: BackgroundLocationPlugin?

    private var locationManager: CLLocationManager?
    private var lastPosition: CLLocation?
    private var supabaseConfig: SupabaseLocationConfig?
    private var pendingUploadLocation: CLLocation?
    private var uploadInFlight = false
    private var locationUploadEnabled = false
    private var uploadRetryWorkItem: DispatchWorkItem?
    /// iOS 13+ never offers "Always" on the first location alert; the system only
    /// shows the upgrade sheet after `requestAlwaysAuthorization()` is called
    /// while status is already `authorizedWhenInUse`. We set this when we have
    /// invoked that upgrade request during the current sharing session so the
    /// delegate does not stack duplicate prompts; reset in `stop()`.
    private var didRequestAlwaysUpgradeThisSharingSession = false
    private var significantLocationMonitoringActive = false
    private var visitMonitoringActive = false
    private var geofenceCenter: CLLocation?
    private var lastFixRequestAt: Date?
    private var wakeBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    private let diagnosticsDefaultsKey = "BackgroundLocationUploadDiagnostics"
    private var lastUploadAt: Date?
    private var lastUploadHttpStatus: Int?
    private var lastUploadErrorSnippet: String?
    private var lastWakeAt: Date?
    private var lastWakeReason: String?
    private var lastDidUpdateAt: Date?
    private var lastUploadedPosition: CLLocation?
    private var lastSuccessfulUploadAt: Date?

    // Queue of pending one-shot getCurrentPosition calls waiting on a fresh fix.
    // Each entry pairs a call with the previous fix timestamp it considers
    // "already seen", so we only resolve it once a genuinely new fix arrives.
    private var pendingFreshCalls: [(call: CAPPluginCall, previousTimestamp: Date?)] = []

    // Maximum age of a cached fix before getCurrentPosition forces a refresh.
    private let cachedLocationMaxAge: TimeInterval = 30

    // Hard deadline for a pending getCurrentPosition call waiting on a fresh
    // fix. If Core Location hasn't delivered anything new by then we give up
    // and let JS treat this poll as "no fix" rather than writing stale
    // coordinates to the DB.
    private let freshFixDeadline: TimeInterval = 12

    // Maximum age, in seconds, of a `CLLocation.timestamp` we'll accept from
    // Core Location. iOS often replays a cached fix (sometimes hours or days
    // old, e.g. after the device travels with the app force-quit) when location
    // services first start or when the app foregrounds. Those cached fixes were
    // getting forwarded to JS as if they were "live", which is how a phone in
    // Denver kept reporting San Francisco coordinates with a fresh `updated_at`.
    private let acceptedFixMaxAge: TimeInterval = 60

    // Reject fixes whose horizontal accuracy is non-positive (Core Location
    // uses negative values to signal an invalid fix). We don't apply a strict
    // upper bound because that disqualifies indoor users entirely; the age
    // check above is the main defense against stale-cache replay.
    private let minAcceptableHorizontalAccuracy: CLLocationAccuracy = 0
    private let locationUploadRetryDelay: TimeInterval = 15
    /// Minimum time between uploads unless the device moved at least
    /// `movementUploadThresholdMeters`.
    private let minimumUploadInterval: TimeInterval = 60
    private let movementUploadThresholdMeters: CLLocationDistance = 10
    /// Significant-change fixes are cell/Wi-Fi based and often several hundred
    /// meters off; anything coarser than this gets one follow-up `requestLocation()`.
    private let refineAccuracyThreshold: CLLocationAccuracy = 100
    /// Rate limit for non-forced `requestLocation()` calls (refines, stale-cache
    /// replays, relaunch) so a run of poor fixes cannot keep the GPS spinning.
    private let minimumFixRequestInterval: TimeInterval = 20
    /// Region monitoring is unreliable below ~100 m; exits are typically
    /// reported after crossing the boundary by a further 20 m or more.
    private let geofenceRadiusMeters: CLLocationDistance = 150
    private let geofenceRecenterThresholdMeters: CLLocationDistance = 25
    private let geofenceIdentifier = "union.locationSharing.geofence"
    /// Background time requested for each wake so a cold relaunch has room for
    /// a GPS fix plus the upload (the system grants ~10 s by default).
    private let wakeWindowSeconds: TimeInterval = 25

    private struct SupabaseLocationConfig: Codable {
        let anonKey: String
        let uploadUrl: String
        let uploadGrant: String
        let uploadGrantExpiresAt: String?
        let userId: String
        let instanceId: String?
        let sourcePlatform: String?
        let sourceUserAgent: String?
    }

    private let configDefaultsKey = "BackgroundLocationSupabaseConfig"
    private let sharingActiveDefaultsKey = "BackgroundLocationSharingActive"
    private let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private lazy var uploadSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config)
    }()

    // MARK: - App lifecycle

    /// Must run from `application(_:didFinishLaunchingWithOptions:)` so that a
    /// background relaunch for a region exit, visit, or significant change has
    /// a delegate to deliver the event to.
    func handleAppLaunch() {
        ensureLocationManager()
        guard UserDefaults.standard.bool(forKey: sharingActiveDefaultsKey), supabaseConfig != nil else { return }
        locationUploadEnabled = true
        applyBackgroundUpdatesIfAuthorized()
        armPassiveMonitoring()
        logLocationRuntimeState(context: "appLaunch")
    }

    // MARK: - Plugin methods

    func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.ensureLocationManager()
            guard self.updateSupabaseConfig(from: call) else {
                self.setLocationUploadEnabled(false)
                call.reject("Missing Supabase location upload config")
                return
            }
            self.setLocationUploadEnabled(true)

            let status = self.locationManager?.authorizationStatus ?? .notDetermined
            NSLog("[BackgroundLocation] start() called, authorizationStatus=\(self.describe(status))")

            switch status {
            case .notDetermined:
                // First prompt is always When-In-Use only; the delegate chains
                // `requestAlwaysAuthorization()` after the user grants so they see
                // Apple's second "Change to Always Allow" sheet.
                self.locationManager?.requestWhenInUseAuthorization()
            case .authorizedWhenInUse:
                self.didRequestAlwaysUpgradeThisSharingSession = true
                self.locationManager?.requestAlwaysAuthorization()
            case .denied, .restricted:
                NSLog("[BackgroundLocation] start(): Location services are denied/restricted. User must enable in Settings -> Privacy -> Location Services -> Union.")
            default:
                break
            }

            self.applyBackgroundUpdatesIfAuthorized()
            self.armPassiveMonitoring()
            self.requestFix(reason: "start", force: true)
            self.logLocationRuntimeState(context: "start")
            call.resolve()
        }
    }

    func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.setLocationUploadEnabled(false)
            self.didRequestAlwaysUpgradeThisSharingSession = false
            self.pendingUploadLocation = nil
            self.uploadRetryWorkItem?.cancel()
            self.uploadRetryWorkItem = nil
            self.disarmPassiveMonitoring()
            self.applyBackgroundUpdatesIfAuthorized()
            self.locationManager?.stopUpdatingLocation()
            self.logLocationRuntimeState(context: "stop")
            call.resolve()
        }
    }

    func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("Plugin not ready")
                return
            }
            self.ensureLocationManager()
            call.resolve(self.buildStatusPayload())
        }
    }

    func getCurrentPosition(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                call.reject("Plugin not ready")
                return
            }

            // Fresh enough? Return immediately. We require both a recent timestamp
            // and a valid horizontal accuracy — Core Location returns negative
            // accuracy for invalid/cached fixes, which we never want to write.
            if let loc = self.lastPosition,
               Date().timeIntervalSince(loc.timestamp) < self.cachedLocationMaxAge,
               loc.horizontalAccuracy > self.minAcceptableHorizontalAccuracy {
                call.resolve([
                    "lat": loc.coordinate.latitude,
                    "lng": loc.coordinate.longitude
                ])
                return
            }

            self.ensureLocationManager()
            let previousTimestamp = self.lastPosition?.timestamp
            self.pendingFreshCalls.append((call, previousTimestamp))

            // Request authorization on first use. One-shot callers like the
            // selfie capture reach this code path before `start()` has ever
            // run, so the manager is still in `.notDetermined` and any call
            // to `requestLocation()` would fail immediately with
            // kCLErrorDenied. Ask for When-In-Use here — the broader Always
            // auth is requested later by `start()` when the user actually
            // turns on background location sharing.
            let status = self.locationManager?.authorizationStatus ?? .notDetermined
            switch status {
            case .notDetermined:
                self.locationManager?.requestWhenInUseAuthorization()
            case .denied, .restricted:
                break
            default:
                // One-shot only: `startUpdatingLocation()` here would leave the
                // GPS running indefinitely after the caller is satisfied.
                self.locationManager?.requestLocation()
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + self.freshFixDeadline) { [weak self] in
                // Time is up. flushPendingCalls(force: true) will resolve any
                // pending callers with an empty payload if we still don't have
                // a sufficiently fresh fix — JS treats that as "no fix this
                // poll" and skips the upsert, which is the desired behavior.
                self?.flushPendingCalls(force: true)
            }
        }
    }

    // MARK: - Delegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Use the most recent acceptable fix. Core Location occasionally
        // hands back cached locations that are seconds — or, after travel
        // with the app force-quit, hours/days — old. We need to drop those
        // before they get forwarded to JS, otherwise they end up in the DB.
        guard let location = mostRecent(of: locations) else { return }
        let age = Date().timeIntervalSince(location.timestamp)

        if location.horizontalAccuracy <= minAcceptableHorizontalAccuracy {
            NSLog("[BackgroundLocation] discarding fix with invalid accuracy=\(location.horizontalAccuracy) age=\(String(format: "%.1f", age))s")
            return
        }
        if shouldDiscardSimulatedLocation(location) {
            NSLog("[BackgroundLocation] discarding simulated location lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude)")
            return
        }
        if age > acceptedFixMaxAge {
            NSLog("[BackgroundLocation] discarding stale cached fix age=\(String(format: "%.1f", age))s lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude)")
            if locationUploadEnabled || !pendingFreshCalls.isEmpty {
                requestFix(reason: "staleCache", force: false)
            }
            return
        }

        lastDidUpdateAt = Date()
        persistUploadDiagnostics()
        lastPosition = location
        plugin?.emitLocationUpdate(location)

        if locationUploadEnabled {
            if UIApplication.shared.applicationState == .background {
                beginWakeWindow(reason: "locationUpdate")
            }
            refreshGeofence(around: location)
            if location.horizontalAccuracy > refineAccuracyThreshold {
                requestFix(reason: "refine", force: false)
            }
            if shouldUploadLocation(location) {
                NSLog("[BackgroundLocation] didUpdateLocations lat=\(location.coordinate.latitude) lng=\(location.coordinate.longitude) horizAcc=\(location.horizontalAccuracy)m age=\(String(format: "%.1f", age))s — uploading")
                postLocationToSupabase(location)
            }
        }
        flushPendingCalls(force: false)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[BackgroundLocation] didFailWithError: \(error.localizedDescription)")
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard locationUploadEnabled else { return }
        let kind = visit.departureDate == .distantFuture ? "arrival" : "departure"
        beginWakeWindow(reason: "visit-\(kind)")
        requestFix(reason: "visit-\(kind)", force: true)
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard region.identifier == geofenceIdentifier, locationUploadEnabled else { return }
        beginWakeWindow(reason: "geofenceExit")
        requestFix(reason: "geofenceExit", force: true)
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        NSLog("[BackgroundLocation] region monitoring failed for \(region?.identifier ?? "nil"): \(error.localizedDescription)")
        if region?.identifier == geofenceIdentifier {
            geofenceCenter = nil
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        NSLog("[BackgroundLocation] authorization changed -> \(describe(status))")
        if status == .authorizedWhenInUse, locationUploadEnabled,
           !didRequestAlwaysUpgradeThisSharingSession {
            didRequestAlwaysUpgradeThisSharingSession = true
            manager.requestAlwaysAuthorization()
        }
        if status == .authorizedAlways || status == .authorizedWhenInUse {
            applyBackgroundUpdatesIfAuthorized()
            if locationUploadEnabled {
                armPassiveMonitoring()
                requestFix(reason: "authorizationChanged", force: false)
            } else if !pendingFreshCalls.isEmpty {
                // A one-shot caller (e.g. selfie capture) was waiting on this prompt.
                manager.requestLocation()
            }
        } else if status == .denied || status == .restricted {
            // Permission was refused. No fix will ever arrive, so resolve
            // any pending one-shot callers now with an empty payload rather
            // than making them wait for the full deadline.
            flushPendingCalls(force: true)
        }
        logLocationRuntimeState(context: "authorizationChanged")
    }

    // MARK: - Passive monitoring

    private func armPassiveMonitoring() {
        guard let manager = locationManager, locationUploadEnabled else { return }
        manager.showsBackgroundLocationIndicator = false
        if CLLocationManager.significantLocationChangeMonitoringAvailable(),
           !significantLocationMonitoringActive {
            manager.startMonitoringSignificantLocationChanges()
            significantLocationMonitoringActive = true
            NSLog("[BackgroundLocation] started significant location change monitoring")
        }
        if !visitMonitoringActive {
            manager.startMonitoringVisits()
            visitMonitoringActive = true
            NSLog("[BackgroundLocation] started visit monitoring")
        }
        if let last = lastPosition {
            refreshGeofence(around: last)
        }
    }

    private func disarmPassiveMonitoring() {
        guard let manager = locationManager else { return }
        if significantLocationMonitoringActive {
            manager.stopMonitoringSignificantLocationChanges()
            significantLocationMonitoringActive = false
        }
        if visitMonitoringActive {
            manager.stopMonitoringVisits()
            visitMonitoringActive = false
        }
        // Region monitoring persists across launches, so clear by identifier
        // rather than relying on in-memory state.
        for region in manager.monitoredRegions where region.identifier == geofenceIdentifier {
            manager.stopMonitoring(for: region)
        }
        geofenceCenter = nil
        NSLog("[BackgroundLocation] stopped passive location monitoring")
    }

    private func refreshGeofence(around location: CLLocation) {
        guard let manager = locationManager,
              CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        if let center = geofenceCenter,
           location.distance(from: center) < geofenceRecenterThresholdMeters,
           location.horizontalAccuracy >= center.horizontalAccuracy {
            return
        }
        let radius = min(max(geofenceRadiusMeters, location.horizontalAccuracy),
                         manager.maximumRegionMonitoringDistance)
        let region = CLCircularRegion(center: location.coordinate, radius: radius, identifier: geofenceIdentifier)
        region.notifyOnEntry = false
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
        geofenceCenter = location
    }

    /// Ask Core Location for a single fix. Non-forced requests are rate limited.
    private func requestFix(reason: String, force: Bool) {
        guard let manager = locationManager else { return }
        let status = manager.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else { return }
        let now = Date()
        if !force, let last = lastFixRequestAt, now.timeIntervalSince(last) < minimumFixRequestInterval {
            return
        }
        lastFixRequestAt = now
        lastWakeAt = now
        lastWakeReason = reason
        persistUploadDiagnostics()
        NSLog("[BackgroundLocation] requesting fix (\(reason))")
        manager.requestLocation()
    }

    private func beginWakeWindow(reason: String) {
        guard wakeBackgroundTask == .invalid else { return }
        wakeBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "LocationWake") { [weak self] in
            self?.endWakeWindow()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + wakeWindowSeconds) { [weak self] in
            self?.endWakeWindow()
        }
        NSLog("[BackgroundLocation] wake (\(reason)) appState=\(describe(UIApplication.shared.applicationState))")
    }

    private func endWakeWindow() {
        guard wakeBackgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(wakeBackgroundTask)
        wakeBackgroundTask = .invalid
    }

    // MARK: - Helpers

    private func ensureLocationManager() {
        if locationManager == nil {
            let manager = CLLocationManager()
            manager.delegate = self
            // Applies to `requestLocation()`: Core Location returns as soon as it
            // reaches this accuracy, so each one-shot powers GPS only briefly.
            manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            manager.showsBackgroundLocationIndicator = false
            loadUploadDiagnostics()
            locationManager = manager
            loadSupabaseConfig()
        }
    }

    private func setLocationUploadEnabled(_ enabled: Bool) {
        locationUploadEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: sharingActiveDefaultsKey)
    }

    private func updateSupabaseConfig(from call: CAPPluginCall) -> Bool {
        guard
            let anonKey = call.getString("anonKey"), !anonKey.isEmpty,
            let uploadUrl = call.getString("uploadUrl"), !uploadUrl.isEmpty,
            let uploadGrant = call.getString("uploadGrant"), !uploadGrant.isEmpty,
            let userId = call.getString("userId"), !userId.isEmpty
        else {
            loadSupabaseConfig()
            return false
        }

        let config = SupabaseLocationConfig(
            anonKey: anonKey,
            uploadUrl: uploadUrl,
            uploadGrant: uploadGrant,
            uploadGrantExpiresAt: call.getString("uploadGrantExpiresAt"),
            userId: userId,
            instanceId: call.getString("instanceId"),
            sourcePlatform: call.getString("sourcePlatform"),
            sourceUserAgent: call.getString("sourceUserAgent")
        )
        supabaseConfig = config
        if let encoded = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(encoded, forKey: configDefaultsKey)
        }
        NSLog("[BackgroundLocation] updated Supabase config user=\(redact(config.userId)) instance=\(redact(config.instanceId))")
        startNextLocationUploadIfNeeded()
        return true
    }

    private func loadSupabaseConfig() {
        if supabaseConfig != nil { return }
        guard let data = UserDefaults.standard.data(forKey: configDefaultsKey),
              let config = try? JSONDecoder().decode(SupabaseLocationConfig.self, from: data)
        else { return }
        supabaseConfig = config
    }

    private func postLocationToSupabase(_ location: CLLocation) {
        guard locationUploadEnabled else {
            NSLog("[BackgroundLocation] location upload skipped: upload disabled")
            return
        }
        pendingUploadLocation = location
        uploadRetryWorkItem?.cancel()
        uploadRetryWorkItem = nil
        startNextLocationUploadIfNeeded()
    }

    private func startNextLocationUploadIfNeeded() {
        guard !uploadInFlight else { return }
        guard locationUploadEnabled else { return }
        guard let location = pendingUploadLocation else { return }
        guard let config = supabaseConfig else {
            NSLog("[BackgroundLocation] no Supabase config; keeping latest location pending")
            return
        }
        pendingUploadLocation = nil
        uploadInFlight = true

        guard let url = URL(string: config.uploadUrl) else {
            NSLog("[BackgroundLocation] invalid location upload URL")
            uploadInFlight = false
            pendingUploadLocation = location
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(config.anonKey)", forHTTPHeaderField: "Authorization")
        request.setValue(config.uploadGrant, forHTTPHeaderField: "X-Location-Upload-Grant")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // `updated_at` is the fix time, so viewers see how old the position
        // actually is (e.g. "Updated 20 min ago" for a stationary sharer).
        let body: [String: Any] = [
            "action": "upload",
            "lat": location.coordinate.latitude,
            "lng": location.coordinate.longitude,
            "updated_at": isoFormatter.string(from: location.timestamp)
        ]
        NSLog("[BackgroundLocation] uploading location user=\(redact(config.userId)) instance=\(redact(config.instanceId))")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        } catch {
            NSLog("[BackgroundLocation] failed to encode location body: \(error.localizedDescription)")
            uploadInFlight = false
            pendingUploadLocation = location
            return
        }

        var backgroundTask: UIBackgroundTaskIdentifier = .invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "UploadLocation") {
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }

        uploadSession.dataTask(with: request) { [weak self] data, response, error in
            defer {
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                }
            }
            if let error = error {
                NSLog("[BackgroundLocation] Supabase location upload failed: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self?.recordUploadResult(httpStatus: nil, errorSnippet: error.localizedDescription)
                    self?.handleLocationUploadFinished(location: location, succeeded: false)
                }
                return
            }
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            if statusCode < 200 || statusCode >= 300 {
                let responseBody = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let trimmedBody = String(responseBody.prefix(1000))
                NSLog("[BackgroundLocation] Supabase location upload returned HTTP \(statusCode) body=\(trimmedBody)")
                DispatchQueue.main.async {
                    self?.recordUploadResult(httpStatus: statusCode, errorSnippet: trimmedBody)
                    if statusCode == 401 || statusCode == 403 {
                        self?.handleLocationUploadRejected(location: location)
                    } else {
                        self?.handleLocationUploadFinished(location: location, succeeded: false)
                    }
                }
                return
            }
            NSLog("[BackgroundLocation] Supabase location upload succeeded")
            DispatchQueue.main.async {
                self?.recordUploadResult(httpStatus: statusCode, errorSnippet: nil)
                self?.handleLocationUploadFinished(location: location, succeeded: true)
            }
        }.resume()
    }

    private func handleLocationUploadFinished(location: CLLocation, succeeded: Bool) {
        uploadInFlight = false
        if !succeeded {
            if pendingUploadLocation == nil ||
                (pendingUploadLocation?.timestamp ?? .distantPast) <= location.timestamp {
                pendingUploadLocation = location
            }
            scheduleLocationUploadRetry()
            return
        }
        lastUploadedPosition = location
        lastSuccessfulUploadAt = Date()
        startNextLocationUploadIfNeeded()
        if pendingUploadLocation == nil {
            endWakeWindow()
        }
    }

    /// 403 means every share from this device has expired or been removed;
    /// 401 means the grant is invalid. Either way, stop all passive monitoring
    /// until the WebView calls `start()` again with a fresh grant.
    private func handleLocationUploadRejected(location: CLLocation) {
        uploadInFlight = false
        pendingUploadLocation = location
        setLocationUploadEnabled(false)
        disarmPassiveMonitoring()
        applyBackgroundUpdatesIfAuthorized()
        endWakeWindow()
        NSLog("[BackgroundLocation] upload grant rejected; waiting for WebView to provide a fresh grant")
    }

    private func shouldUploadLocation(_ location: CLLocation) -> Bool {
        guard let lastAt = lastSuccessfulUploadAt else { return true }
        if Date().timeIntervalSince(lastAt) >= minimumUploadInterval { return true }
        if let lastUploaded = lastUploadedPosition,
           location.distance(from: lastUploaded) >= movementUploadThresholdMeters {
            return true
        }
        return false
    }

    private func scheduleLocationUploadRetry() {
        guard uploadRetryWorkItem == nil else { return }
        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.uploadRetryWorkItem = nil
            self.startNextLocationUploadIfNeeded()
        }
        uploadRetryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + locationUploadRetryDelay, execute: workItem)
    }

    private func recordUploadResult(httpStatus: Int?, errorSnippet: String?) {
        lastUploadAt = Date()
        lastUploadHttpStatus = httpStatus
        lastUploadErrorSnippet = errorSnippet.map { String($0.prefix(200)) }
        persistUploadDiagnostics()
    }

    private struct PersistedUploadDiagnostics: Codable {
        let lastUploadAt: Date?
        let lastUploadHttpStatus: Int?
        let lastUploadErrorSnippet: String?
        let lastWakeAt: Date?
        let lastWakeReason: String?
        let lastDidUpdateAt: Date?
    }

    private func persistUploadDiagnostics() {
        let snapshot = PersistedUploadDiagnostics(
            lastUploadAt: lastUploadAt,
            lastUploadHttpStatus: lastUploadHttpStatus,
            lastUploadErrorSnippet: lastUploadErrorSnippet,
            lastWakeAt: lastWakeAt,
            lastWakeReason: lastWakeReason,
            lastDidUpdateAt: lastDidUpdateAt
        )
        if let encoded = try? JSONEncoder().encode(snapshot) {
            UserDefaults.standard.set(encoded, forKey: diagnosticsDefaultsKey)
        }
    }

    private func loadUploadDiagnostics() {
        guard let data = UserDefaults.standard.data(forKey: diagnosticsDefaultsKey),
              let snapshot = try? JSONDecoder().decode(PersistedUploadDiagnostics.self, from: data)
        else { return }
        lastUploadAt = snapshot.lastUploadAt
        lastUploadHttpStatus = snapshot.lastUploadHttpStatus
        lastUploadErrorSnippet = snapshot.lastUploadErrorSnippet
        lastWakeAt = snapshot.lastWakeAt
        lastWakeReason = snapshot.lastWakeReason
        lastDidUpdateAt = snapshot.lastDidUpdateAt
    }

    private func isoString(_ date: Date?) -> String? {
        guard let date = date else { return nil }
        return isoFormatter.string(from: date)
    }

    /// `allowsBackgroundLocationUpdates` requires Always authorization at the
    /// time it's set, and is only needed so a `requestLocation()` issued during
    /// a background wake can complete. The indicator stays off: none of the
    /// passive services we use require it.
    private func applyBackgroundUpdatesIfAuthorized() {
        guard let manager = locationManager else { return }
        let wanted = manager.authorizationStatus == .authorizedAlways && locationUploadEnabled
        if manager.allowsBackgroundLocationUpdates != wanted {
            manager.allowsBackgroundLocationUpdates = wanted
        }
        manager.showsBackgroundLocationIndicator = false
    }

    private func buildStatusPayload() -> [String: Any] {
        var base: [String: Any] = [
            "hasSupabaseConfig": supabaseConfig != nil,
            "hasUploadGrant": !(supabaseConfig?.uploadGrant.isEmpty ?? true),
            "configUser": redact(supabaseConfig?.userId),
            "configInstance": redact(supabaseConfig?.instanceId),
            "locationUploadEnabled": locationUploadEnabled,
            "hasPendingUpload": pendingUploadLocation != nil,
            "uploadInFlight": uploadInFlight,
            "appState": describe(UIApplication.shared.applicationState),
            "significantLocationMonitoringActive": significantLocationMonitoringActive,
            "visitMonitoringActive": visitMonitoringActive,
            "geofenceActive": geofenceCenter != nil
        ]
        if let v = isoString(lastUploadAt) { base["lastUploadAt"] = v }
        if let v = lastUploadHttpStatus { base["lastUploadHttpStatus"] = v }
        if let v = lastUploadErrorSnippet { base["lastUploadErrorSnippet"] = v }
        if let v = isoString(lastWakeAt) { base["lastWakeAt"] = v }
        if let v = lastWakeReason { base["lastWakeReason"] = v }
        if let v = isoString(lastDidUpdateAt) { base["lastDidUpdateAt"] = v }
        if let v = supabaseConfig?.uploadGrantExpiresAt { base["uploadGrantExpiresAt"] = v }
        guard let manager = locationManager else {
            base["authorizationStatus"] = "notInitialized"
            base["allowsBackgroundLocationUpdates"] = false
            base["showsBackgroundLocationIndicator"] = false
            return base
        }
        base["authorizationStatus"] = describe(manager.authorizationStatus)
        base["allowsBackgroundLocationUpdates"] = manager.allowsBackgroundLocationUpdates
        base["showsBackgroundLocationIndicator"] = manager.showsBackgroundLocationIndicator
        return base
    }

    private func logLocationRuntimeState(context: String) {
        let status = buildStatusPayload()
        NSLog("[BackgroundLocation] state[\(context)] authorizationStatus=\(status["authorizationStatus"] ?? "") allowsBackgroundLocationUpdates=\(status["allowsBackgroundLocationUpdates"] ?? false) significantChanges=\(status["significantLocationMonitoringActive"] ?? false) visits=\(status["visitMonitoringActive"] ?? false) geofence=\(status["geofenceActive"] ?? false) hasSupabaseConfig=\(status["hasSupabaseConfig"] ?? false) configUser=\(status["configUser"] ?? "") configInstance=\(status["configInstance"] ?? "") locationUploadEnabled=\(status["locationUploadEnabled"] ?? false) hasPendingUpload=\(status["hasPendingUpload"] ?? false) uploadInFlight=\(status["uploadInFlight"] ?? false) appState=\(status["appState"] ?? "")")
    }

    private func mostRecent(of locations: [CLLocation]) -> CLLocation? {
        return locations.max(by: { $0.timestamp < $1.timestamp })
    }

    private func shouldDiscardSimulatedLocation(_ location: CLLocation) -> Bool {
        if #available(iOS 15.0, *) {
            guard location.sourceInformation?.isSimulatedBySoftware == true else { return false }
            #if DEBUG
            NSLog("[BackgroundLocation] accepting simulated location in DEBUG build for testing")
            return false
            #else
            return true
            #endif
        }
        return false
    }

    private func describe(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "authorizedAlways"
        case .authorizedWhenInUse: return "authorizedWhenInUse"
        @unknown default: return "unknown(\(status.rawValue))"
        }
    }

    private func describe(_ state: UIApplication.State) -> String {
        switch state {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown(\(state.rawValue))"
        }
    }

    private func redact(_ value: String?) -> String {
        guard let value = value, !value.isEmpty else { return "nil" }
        if value.count <= 12 { return value }
        return "\(value.prefix(6))...\(value.suffix(6))"
    }

    /// Resolve any pending getCurrentPosition calls. When `force` is false,
    /// we only resolve calls whose `previousTimestamp` differs from the
    /// current `lastPosition.timestamp` (i.e. a new fix has genuinely
    /// arrived). When `force` is true the caller's deadline is up; in that
    /// case we still only resolve with `lastPosition` if it's *both* newer
    /// than what the caller had AND fresh enough to be worth writing. If not,
    /// resolve with an empty object so JS treats the poll as "no fix" without
    /// Capacitor logging noisy promise rejections.
    private func flushPendingCalls(force: Bool) {
        guard !pendingFreshCalls.isEmpty else { return }
        let current = lastPosition
        var remaining: [(call: CAPPluginCall, previousTimestamp: Date?)] = []

        for entry in pendingFreshCalls {
            let isNew = current.map { $0.timestamp != entry.previousTimestamp } ?? false
            let isFreshEnough = current.map {
                Date().timeIntervalSince($0.timestamp) <= acceptedFixMaxAge &&
                    $0.horizontalAccuracy > minAcceptableHorizontalAccuracy
            } ?? false

            if let loc = current, isNew, isFreshEnough {
                entry.call.resolve([
                    "lat": loc.coordinate.latitude,
                    "lng": loc.coordinate.longitude
                ])
            } else if force {
                NSLog("[BackgroundLocation] getCurrentPosition timed out without a fresh fix (had cached fix: \(current != nil))")
                entry.call.resolve([:])
            } else {
                remaining.append(entry)
            }
        }
        pendingFreshCalls = remaining
    }
}
