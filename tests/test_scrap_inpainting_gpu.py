"""Run inside the Modal GPU image; skipped when the VSR runtime is absent."""
import importlib.util
import unittest

HAS_RUNTIME = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("backend") is not None


@unittest.skipUnless(HAS_RUNTIME, "Requires the Scrap GPU image")
class InpaintingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import cv2
        import numpy as np
        import torch
        from backend.inpaint.propainter_inpaint import PropainterInpaint
        from backend.tools.model_config import ModelConfig
        cls.torch, cls.np = torch, np
        torch.backends.cuda.matmul.allow_tf32 = True
        cls.model = PropainterInpaint(torch.device("cuda"), ModelConfig().PROPAINTER_MODEL_DIR, 30, use_fp16=True)
        cls.model.raft_iter = 12
        # Width 576 previously generated a 112px crop and entirely black output.
        x, y = np.meshgrid(np.arange(576), np.arange(384))
        base = np.stack((100 + x // 5, 110 + y // 4, 150 + (x + y) // 12), axis=-1).clip(0, 255).astype(np.uint8)
        cls.frames = []
        for index in range(8):
            frame = np.roll(base, index, axis=1)
            cv2.putText(frame, "SCRAP", (110, 155), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
            cls.frames.append(frame)
        cls.mask = np.zeros((384, 576), dtype=np.uint8)
        cls.mask[120:166, 100:245] = 255

    @classmethod
    def tearDownClass(cls):
        import gc
        del cls.model
        gc.collect()
        cls.torch.cuda.empty_cache()

    def test_reconstructs_pixels_in_a_narrow_text_region(self):
        import cv2
        output = self.model(self.frames, self.mask)
        outside = cv2.dilate(self.mask, self.np.ones((9, 9), dtype=self.np.uint8)) == 0
        self.assertEqual(len(output), len(self.frames))
        for original, cleaned in zip(self.frames, output):
            self.assertEqual(cleaned.shape, original.shape)
            self.assertGreater(float(cleaned[self.mask > 0].mean()), 40)
            self.np.testing.assert_array_equal(cleaned[outside], original[outside])

    def test_refuses_invalid_predictions_before_they_become_black_pixels(self):
        hook = self.model.model.register_forward_hook(lambda _module, _inputs, output: self.torch.full_like(output, float("nan")))
        try:
            with self.assertRaisesRegex(RuntimeError, "invalid pixels"):
                self.model(self.frames, self.mask)
        finally:
            hook.remove()

    def test_refuses_crops_too_small_for_the_motion_model(self):
        frames = [frame[:96] for frame in self.frames]
        mask = self.np.ones((96, 576), dtype=self.np.uint8) * 255
        with self.assertRaisesRegex(RuntimeError, "at least 128"):
            self.model(frames, mask)

    def test_crop_preserves_text_at_both_image_edges(self):
        from vsr_runtime import get_inpaint_regions
        for first, last in [(0, 20), (540, 576), (140, 360), (0, 576)]:
            mask = self.np.zeros((1024, 576, 1), dtype=self.np.uint8)
            mask[220:280, first:last] = 255
            areas = get_inpaint_regions(576, 1024, 192, mask)
            self.assertTrue(areas)
            for top, bottom, left, right in areas:
                self.assertGreaterEqual(right - left, 128)
                self.assertLessEqual(left, first)
                self.assertGreaterEqual(right, last)
                self.assertLessEqual(top, 220)
                self.assertGreaterEqual(bottom, 280)

    def test_non_multiple_of_eight_keeps_edge_pixels_and_dimensions(self):
        frames = [frame[:, :570] for frame in self.frames]
        mask = self.np.zeros((384, 570), dtype=self.np.uint8)
        mask[120:166, 535:] = 255
        output = self.model(frames, mask)
        self.assertEqual(len(output), len(frames))
        for original, cleaned in zip(frames, output):
            self.assertEqual(cleaned.shape, original.shape)
            self.assertGreater(float(cleaned[mask > 0].mean()), 40)
            self.np.testing.assert_array_equal(cleaned[:, :500], original[:, :500])

    def test_nearby_caption_lines_share_context_but_distant_lines_stay_separate(self):
        from vsr_runtime import get_inpaint_regions
        mask = self.np.zeros((1024, 576), dtype=self.np.uint8)
        for top in (220, 250, 280):
            mask[top:top + 15, 100:400] = 255
        areas = get_inpaint_regions(576, 1024, 192, mask)
        self.assertEqual(len(areas), 1)
        top, bottom, left, right = areas[0]
        self.assertLessEqual(top, 220)
        self.assertGreaterEqual(bottom, 295)
        self.assertLessEqual(bottom - top, 288)
        mask[880:900, 100:400] = 255
        self.assertEqual(len(get_inpaint_regions(576, 1024, 192, mask)), 2)

    def test_tall_text_is_fully_covered(self):
        from vsr_runtime import get_inpaint_regions
        mask = self.np.zeros((1024, 576), dtype=self.np.uint8)
        mask[250:550, 100:400] = 255
        areas = get_inpaint_regions(576, 1024, 192, mask)
        self.assertEqual(len(areas), 1)
        top, bottom, left, right = areas[0]
        self.assertLessEqual(top, 250)
        self.assertGreaterEqual(bottom, 550)


if __name__ == "__main__":
    unittest.main()
