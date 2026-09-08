import sys
from pathlib import Path
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/scrap"))
from job_control import JobControl, JobCancelled, progress_details


class Store(dict):
    def put(self, key, value, skip_if_exists=False):
        if skip_if_exists and key in self:
            return False
        self[key] = value
        return True


class Call:
    def __init__(self, name, events):
        self.object_id, self.events = name, events

    def cancel(self, terminate_containers=False):
        assert terminate_containers
        self.events.append(self.object_id)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.jobs = Store(a={"id": "a", "status": "queued", "removeText": True})
        self.calls, self.cancelled = Store(), Store()
        self.control = JobControl(self.jobs, self.calls, self.cancelled, lambda name: Call(name, self.events))

    def test_stop_targets_child_then_parent_and_is_idempotent(self):
        for kind in ("cpu", "warmup", "gpu"):
            self.control.spawn("a", kind, lambda: Call(kind, self.events))
        self.calls["other:gpu"] = {"id": "unrelated"}
        self.assertEqual(self.control.cancel("a")["status"], "cancelled")
        self.assertEqual(self.events, ["gpu", "warmup", "cpu"])
        self.control.cancel("a")
        self.assertEqual(len(self.events), 3)
        with self.assertRaises(JobCancelled):
            self.control.update("a", "completed", key="result.mp4")
        # Even an already in-flight status write cannot resurrect a stopped job.
        self.jobs["a"]["status"] = "completed"
        self.assertEqual(self.control.snapshot("a")["status"], "cancelled")

    def test_stop_before_submission_prevents_late_start(self):
        self.assertEqual(self.control.cancel("future")["status"], "cancelled")
        with self.assertRaises(JobCancelled):
            self.control.spawn("future", "cpu", lambda: self.fail("must not start"))

    def test_cancellation_waits_for_child_handle_before_killing_parent(self):
        dispatching, release = threading.Event(), threading.Event()
        self.control.spawn("a", "cpu", lambda: Call("cpu", self.events))
        def delayed_spawn():
            dispatching.set()
            self.assertTrue(release.wait(2))
            return Call("gpu", self.events)
        def dispatch():
            try:
                self.control.spawn("a", "gpu", delayed_spawn)
            except JobCancelled:
                pass
        child = threading.Thread(target=dispatch)
        child.start()
        self.assertTrue(dispatching.wait(2))
        original_sleep = self.control.sleep
        def while_waiting(seconds):
            self.assertNotIn("cpu", self.events)
            release.set()
            original_sleep(seconds)
        self.control.sleep = while_waiting
        result = self.control.cancel("a")
        child.join(2)
        self.assertFalse(child.is_alive())
        self.assertEqual(result["status"], "cancelled")
        self.assertIn("gpu", self.events)
        self.assertEqual(self.events[-1], "cpu")

    def test_failed_stop_remains_pending_until_successful_retry(self):
        self.calls["a:gpu"] = {"id": "gpu"}
        original = self.control.restore_call
        self.control.restore_call = lambda _: (_ for _ in ()).throw(RuntimeError("network"))
        with self.assertRaises(RuntimeError):
            self.control.cancel("a")
        self.assertEqual(self.control.snapshot("a")["status"], "cancelling")
        self.control.restore_call = original
        self.assertEqual(self.control.cancel("a")["status"], "cancelled")

    def test_completed_video_is_preserved(self):
        self.jobs["a"].update(status="completed", key="result.mp4")
        self.assertEqual(self.control.cancel("a")["key"], "result.mp4")
        self.assertFalse(self.cancelled)

    def test_progress_is_monotonic_and_eta_uses_observed_rate(self):
        job = self.jobs["a"]
        for stage, now, percentage in [("downloading", 0, 0), ("starting", 5, 0),
            ("detecting", 10, 0), ("detecting", 14, 100), ("cleaning", 14, 0),
            ("cleaning", 24, 50), ("exporting", 34, 0), ("completed", 37, 0)]:
            previous = job.get("overallProgress", 0)
            job = progress_details(job, stage, now, progress=percentage, durationSeconds=15)
            self.assertGreaterEqual(job["overallProgress"], previous)
            if stage in ("starting", "downloading"):
                self.assertIsNone(job["etaSeconds"])
            if stage == "cleaning" and percentage == 50:
                self.assertEqual(job["etaSeconds"], 13)  # 10 seconds remaining + export.
            if stage != "completed":
                self.assertLess(job["overallProgress"], 100)
        self.assertEqual(job["overallProgress"], 100)
        self.assertEqual(job["progress"], 100)


if __name__ == "__main__":
    unittest.main()
