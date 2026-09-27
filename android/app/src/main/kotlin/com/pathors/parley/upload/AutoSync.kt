package com.pathors.parley.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope

private const val TAG = "AutoSync"

/**
 * The two moments the phone should try to sync without being asked: the network
 * comes back, and the app comes back.
 *
 * Before this the queues were drained only at launch, after sign-in, at the end
 * of a meeting or an import, and from "Upload now". A recording saved offline
 * sat on the phone until one of those happened to come round, even though
 * `docs/api-cloud.md` had always said to drain "when connectivity returns"; and
 * a re-transcription killed by the phone locking was simply not picked up again
 * until the next cold start — the bug iOS 1.14 fixed by draining its backfill
 * queue whenever the app becomes active (`ParleyApp.swift`, `scenePhase`).
 *
 * - **Connectivity**: a `NetworkCallback` for networks with validated internet
 *   (`NET_CAPABILITY_INTERNET` + `NET_CAPABILITY_VALIDATED`). "Validated" is the
 *   point: a captive portal or a Wi-Fi with no uplink is connected but useless,
 *   and a drain against it only burns attempts.
 * - **Foreground**: [ProcessLifecycleOwner]'s `ON_START`, which fires once when
 *   the first activity becomes visible — not on every rotation, and not per
 *   activity. App-level on purpose; the per-meeting
 *   `ActivityLifecycleCallbacks` in `MeetingSession` answers a different
 *   question (the microphone) and lives only as long as a recording.
 *
 * Both go through [SyncDebouncer], so a flapping network cannot hammer the
 * cloud. This only runs while the process is alive; draining from the
 * background after the process is gone is WorkManager's job and out of scope
 * here.
 *
 * @param sync start one pass. The container's `drainPendingUploads`, which
 *   already skips demo mode and signed-out, and drains backfills after uploads.
 */
class AutoSync(
    private val context: Context,
    scope: CoroutineScope,
    private val sync: (reason: String) -> Unit,
) {
    private val debouncer = SyncDebouncer(
        scope = scope,
        now = SystemClock::elapsedRealtime,
    ) { reason ->
        Log.i(TAG, "sync pass: $reason")
        sync(reason)
    }

    private var started = false

    /** Register both observers. Main thread (the lifecycle observer requires it); idempotent. */
    fun start() {
        if (started) return
        started = true
        ProcessLifecycleOwner.get().lifecycle.addObserver(foreground)
        registerNetworkCallback()
    }

    private val foreground = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            debouncer.foregrounded()
        }
    }

    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            Log.i(TAG, "validated network available")
            debouncer.networkAvailable(network)
        }

        override fun onLost(network: Network) {
            Log.i(TAG, "network lost")
            debouncer.networkLost(network)
        }
    }

    private fun registerNetworkCallback() {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()
        // A listen request: it never asks the system to bring a network up, it
        // only reports the ones that match. A network that loses validation
        // stops matching and arrives here as onLost.
        runCatching { manager.registerNetworkCallback(request, network) }
            .onFailure { Log.w(TAG, "could not watch connectivity", it) }
    }
}
