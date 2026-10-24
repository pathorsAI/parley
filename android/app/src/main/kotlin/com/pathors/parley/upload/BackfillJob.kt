package com.pathors.parley.upload

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import com.pathors.parley.parleyContainer
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Runs the transcript backfill as a system job rather than on a bare coroutine.
 *
 * Until now the backfill drained on the app's coroutine scope (and, for a
 * re-transcription asked for by hand, on the recording screen's
 * `viewModelScope`). A batch job for an hour of audio takes a few minutes, and
 * neither scope survives the person leaving: closing the screen cancelled the
 * poll outright, and a backgrounded process with no foreground service is
 * frozen and then killed. Production showed the result — a job polled for
 * about 40 seconds, the request cancelled, and the same file uploaded again as
 * a new job on the next attempt.
 *
 * A running job keeps the process out of the cached (frozen) state, and one the
 * system stops is rescheduled. Framework JobScheduler rather than WorkManager:
 * the app has no WorkManager dependency, and an expedited JobScheduler job
 * needs no notification, where an expedited WorkManager request below
 * Android 12 has to run as a foreground service with one. What a stopped job
 * leaves behind is cheap to pick up: the batch job id is remembered, so the next
 * run polls it instead of uploading again.
 *
 * The same job drains the *upload* queue first (`AppContainer.runBackfillJob`):
 * a meeting saved with no network has to reach the cloud even if the process
 * is gone by the time the network returns, and one job with a network
 * constraint already covers that without a second mechanism.
 */
object BackfillJob {
    private const val TAG = "BackfillJob"

    /** Fixed: there is one backfill queue, so there is one job draining it. */
    const val JOB_ID = 0x50_42_46_31

    /**
     * Ask for a drain as soon as there is a network. A no-op while one is
     * already pending or running — that run picks up anything queued meanwhile
     * ([TranscriptBackfiller.drainUntilSettled]), and scheduling the same id
     * again would stop it.
     */
    fun schedule(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        if (scheduler.getPendingJob(JOB_ID) != null) return
        val component = ComponentName(context, BackfillJobService::class.java)
        val expedited = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        val scheduled = runCatching { scheduler.schedule(info(component, expedited)) }
            .onFailure { Log.w(TAG, "could not schedule the backfill (expedited=$expedited)", it) }
            .getOrDefault(JobScheduler.RESULT_FAILURE)
        if (scheduled != JobScheduler.RESULT_SUCCESS && expedited) {
            runCatching { scheduler.schedule(info(component, expedited = false)) }
                .onFailure { Log.w(TAG, "could not schedule the backfill", it) }
        }
    }

    private fun info(component: ComponentName, expedited: Boolean): JobInfo =
        JobInfo.Builder(JOB_ID, component)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .apply { if (expedited && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setExpedited(true) }
            .build()
}

/** The system's handle on one [BackfillJob] run. */
class BackfillJobService : JobService() {
    private var work: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val container = parleyContainer
        work = container.appScope.launch {
            container.runBackfillJob()
            jobFinished(params, false)
        }
        return true
    }

    /**
     * The system wants the job gone (quota, the network constraint lost).
     * Cancelling stops the poll where it is; the job id stays remembered, and
     * `true` asks for another run, which resumes it.
     */
    override fun onStopJob(params: JobParameters): Boolean {
        work?.cancel()
        work = null
        return true
    }
}
