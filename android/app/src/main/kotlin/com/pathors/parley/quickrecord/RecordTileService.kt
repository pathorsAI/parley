package com.pathors.parley.quickrecord

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.pathors.parley.R
import com.pathors.parley.meeting.MeetingService
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.isInProgress
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/**
 * "Parley 錄音" in Quick Settings: one swipe down and a tap to a meeting already
 * recording — Android's nearest equivalent of the iOS lock-screen control
 * (`StartRecordingControl`).
 *
 * Like every other door it only opens [QuickRecord.URL]; MainActivity and the
 * navigation graph take it from there, so a tap while a meeting is already
 * going brings that meeting up instead of starting a second one. On a locked
 * phone it asks for the unlock first ([unlockAndRun]): a recording is
 * something you watch, and the app cannot be shown over the keyguard.
 *
 * The tile reads as active while a meeting is in progress (connecting,
 * recording or paused),
 * from the same [MeetingService.activeSession] the meeting screen observes. It
 * is only drawn while the shade is open, so it is only watched then.
 */
class RecordTileService : TileService() {

    private var scope: CoroutineScope? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun onStartListening() {
        super.onStartListening()
        val listening = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        scope = listening
        listening.launch {
            MeetingService.activeSession
                .flatMapLatest { session -> session?.state ?: flowOf(null) }
                .collect { render(it) }
        }
    }

    override fun onStopListening() {
        scope?.cancel()
        scope = null
        super.onStopListening()
    }

    override fun onDestroy() {
        scope?.cancel()
        scope = null
        super.onDestroy()
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { openRecord() } else openRecord()
    }

    private fun render(state: MeetingState?) {
        val tile = qsTile ?: return
        val active = state?.isInProgress == true
        tile.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.subtitle = if (active) getString(R.string.meeting_recording) else null
        tile.updateTile()
    }

    /**
     * API 34 made the Intent overload throw for apps targeting it; the
     * PendingIntent one is the only way there. Below 34 the PendingIntent
     * overload does not exist.
     */
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openRecord() {
        val intent = QuickRecord.intent(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
