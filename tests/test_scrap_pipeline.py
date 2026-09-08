import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pipeline", Path(__file__).parents[1] / "services/scrap/pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


class ScrapPipelineTests(unittest.TestCase):
    def test_validate_and_cobalt_tunnel(self):
        body = {"id": "test-0123456789abcdef0123456789", "url": "https://vm.tiktok.com/test/", "removeText": False}
        self.assertEqual(pipeline.validate_request(body), body)
        for change in ({"removeText": "false"}, {"url": "https://tiktok.com.evil.test/video/1"}, {"id": "../a"}):
            with self.assertRaises(pipeline.ScrapError):
                pipeline.validate_request({**body, **change})
        valid = {"status": "tunnel", "url": "https://cobalt.example/tunnel?id=123"}
        self.assertEqual(pipeline.cobalt_tunnel(valid, "https://cobalt.example/"), valid["url"])
        for response in ({"status": "picker"}, {"status": "error"}, {"status": "redirect", "url": "https://evil.test/x"}, {"status": "tunnel", "url": "https://localhost/tunnel?id=1"}):
            with self.assertRaises(pipeline.ScrapError):
                pipeline.cobalt_tunnel(response, "https://cobalt.example/")

    def test_duration_limits_reject_before_conversion(self):
        for clean, duration in [(True, 181), (False, 601)]:
            with patch.object(pipeline, "probe", return_value={"duration": duration}), patch.object(pipeline, "run") as convert:
                with self.assertRaises(pipeline.ScrapError):
                    pipeline.normalize("source", "target", clean)
                convert.assert_not_called()

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required for media checks")
    def test_real_mp4_conversion_and_audio_remux(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, silent = root / "source.mp4", root / "silent.mp4"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=60:duration=1",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source)], check=True)
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(source), "-c:v", "copy", "-an", str(silent)], check=True)
            for clean in (False, True):
                for input_path in (source, silent):
                    output = root / f"normalized-{clean}-{input_path.name}"
                    pipeline.normalize(input_path, output, clean)
                    self.assertEqual(pipeline.probe(output)["audio"], input_path == source)
            final = root / "final.mp4"
            pipeline.finish_clean_video(silent, source, final)
            self.assertTrue(pipeline.probe(final)["audio"])
            self.assertLess(abs(pipeline.probe(final)["duration"] - pipeline.probe(source)["duration"]), 0.1)
            def video_hash(path):
                return subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0",
                                                "-c", "copy", "-f", "hash", "-hash", "sha256", "-"])
            # Compatible media must keep its encoded pixels without another generation loss.
            self.assertEqual(video_hash(final), video_hash(silent))
            self.assertEqual(video_hash(root / "normalized-False-source.mp4"), video_hash(source))
            self.assertLessEqual(pipeline.probe(root / "normalized-True-source.mp4")["fps"], 30.01)


if __name__ == "__main__":
    unittest.main()
