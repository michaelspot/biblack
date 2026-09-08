"""Job progress and cancellation, independent of the video runtime."""
import math
import time

TERMINAL = {"completed", "failed", "cancelled"}
CALL_KINDS = ("cpu", "warmup", "gpu")


class JobCancelled(Exception):
    pass


def progress_details(job, status, now, **details):
    changed = job.get("status") != status
    percentage = details.get("progress", 0 if changed else job.get("progress", 0))
    percentage = max(0, min(100, percentage))
    if status == "completed":
        percentage = 100
    stage_started = now if changed else job.get("stageStartedAt", now)
    duration = details.get("durationSeconds", job.get("durationSeconds", 0))
    overall = {"queued": 0, "downloading": 2, "starting": 10, "exporting": 95,
               "completed": 100}.get(status, job.get("overallProgress", 0))
    if status == "detecting":
        overall = 12 + percentage * .08
    elif status == "cleaning":
        overall = 20 + percentage * .75
    eta = None
    elapsed = max(0, now - stage_started)
    # Warm H100 measurements provide a starting estimate; actual frame throughput
    # replaces it once there is enough progress. Never estimate an unknown queue.
    if status in ("detecting", "cleaning") and duration:
        expected = duration * (.25 if status == "detecting" else 1.6)
        if percentage >= 5 and elapsed >= 2:
            expected = elapsed * 100 / percentage
        remaining = expected * (1 - percentage / 100)
        eta = math.ceil(remaining + (duration * 1.6 if status == "detecting" else 0) + 3)
    elif status == "exporting":
        eta = 3
    elif status == "completed":
        eta = 0
    return {**job, **details, "status": status, "progress": percentage,
            "overallProgress": math.floor(max(job.get("overallProgress", 0), overall)),
            "stageStartedAt": stage_started, "updatedAt": now,
            "etaSeconds": eta, "etaUpdatedAt": now}


class JobControl:
    def __init__(self, jobs, calls, cancellations, restore_call, clock=time.time, sleep=time.sleep):
        self.jobs, self.calls, self.cancellations = jobs, calls, cancellations
        self.restore_call, self.clock, self.sleep = restore_call, clock, sleep

    def check(self, job_id):
        if self.cancellations.get(job_id):
            raise JobCancelled()

    def update(self, job_id, status, **details):
        self.check(job_id)
        job = self.jobs[job_id]
        if job["status"] in TERMINAL:
            return
        self.jobs[job_id] = progress_details(job, status, self.clock(), **details)

    def spawn(self, job_id, kind, spawn, *args):
        self.check(job_id)
        key = f"{job_id}:{kind}"
        # Cancellation waits for this handoff before killing the parent. That
        # closes the spawn/register race which would otherwise orphan a GPU job.
        self.calls[key] = {"dispatching": True}
        try:
            self.check(job_id)
            call = spawn(*args)
        except BaseException:
            self.calls[key] = {"dispatching": False}
            raise
        self.calls[key] = {"id": call.object_id, "dispatching": False}
        if self.cancellations.get(job_id):
            call.cancel(terminate_containers=True)
            raise JobCancelled()
        return call

    def snapshot(self, job_id):
        job = self.jobs.get(job_id)
        cancellation = self.cancellations.get(job_id)
        if cancellation:
            # The separate tombstone is authoritative even if a progress write
            # was already in flight when the user pressed Stop.
            return {**(job or {"id": job_id, "removeText": False}),
                    "status": "cancelled" if cancellation.get("stopped") else "cancelling",
                    "etaSeconds": None, "updatedAt": cancellation["requestedAt"]}
        return job

    def cancel(self, job_id):
        job = self.snapshot(job_id)
        if job and job["status"] in TERMINAL:
            return job
        self.cancellations.put(job_id, {"requestedAt": self.clock()}, skip_if_exists=True)
        deadline = self.clock() + 10
        while True:
            slots = [self.calls.get(f"{job_id}:{kind}", {}) for kind in CALL_KINDS]
            if not any(slot.get("dispatching") for slot in slots):
                break
            if self.clock() >= deadline:
                return self.snapshot(job_id)  # The next poll retries the stop.
            self.sleep(.1)
        # Stop child GPU calls before their CPU parent. No other job is targeted.
        for slot in reversed(slots):
            if slot.get("id"):
                self.restore_call(slot["id"]).cancel(terminate_containers=True)
        cancellation = self.cancellations[job_id]
        self.cancellations[job_id] = {**cancellation, "stopped": True}
        return self.snapshot(job_id)
