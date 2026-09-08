import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/scrap"))
from vsr_runner import StageProgress


class StageProgressTests(unittest.TestCase):
    def test_reports_each_stage_and_throttles_frame_updates(self):
        events = []
        now = [0]
        reporter = StageProgress(lambda *args: events.append(args), clock=lambda: now[0])
        reporter.update("detecting", 0)
        reporter.update("detecting", 10)
        self.assertEqual(events, [("detecting", 0)])
        now[0] = 2
        reporter.update("detecting", 25)
        reporter.update("detecting", 50)
        reporter.update("cleaning", 0)
        self.assertEqual(events[-3:], [("detecting", 50), ("detecting", 100), ("cleaning", 0)])
        now[0] = 4
        reporter.update("cleaning", 30)
        reporter.update("cleaning", 30)
        reporter.update("cleaning", 100)
        self.assertEqual(events[-2:], [("cleaning", 30), ("cleaning", 100)])


if __name__ == "__main__":
    unittest.main()
