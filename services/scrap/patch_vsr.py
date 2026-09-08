"""Adapt pinned VSR for GPU OCR, progress and valid ProPainter inputs."""
from pathlib import Path


def replace_once(path, before, after):
    source = path.read_text()
    if source.count(before) != 1:
        raise RuntimeError(f"Unexpected VSR revision: {path.name}")
    path.write_text(source.replace(before, after, 1))


def replace_count(path, before, after, count):
    source = path.read_text()
    if source.count(before) != count:
        raise RuntimeError(f"Unexpected VSR revision: {path.name}")
    path.write_text(source.replace(before, after))


def patch(root):
    # VSR's detector explicitly requests CPU independently of hardwareAcceleration.
    replace_once(root / "backend/tools/subtitle_detect.py",
                 'device="cpu",\n            enable_hpi=len(onnx_providers) > 0,',
                 'device="gpu:0",\n            enable_hpi=False,')
    replace_once(root / "backend/tools/subtitle_detect.py",
                 'from paddleocr import TextDetection',
                 'from vsr_runtime import get_text_detector as TextDetection')
    replace_once(root / "backend/main.py",
                 'from backend.inpaint.propainter_inpaint import PropainterInpaint',
                 'from vsr_runtime import get_propainter_model as PropainterInpaint')
    replace_once(root / "backend/tools/subtitle_detect.py",
                 'sub_remover.progress_total = (100 * float(current_frame_no) / float(frame_count)) // 2',
                 'sub_remover.progress_total = (100 * float(current_frame_no) / float(frame_count)) // 2\n'
                 '                sub_remover.notify_progress_listeners()')
    replace_once(root / "backend/main.py",
                 '    def propainter_mode(self, tbar):\n',
                 '    def propainter_mode(self, tbar):\n        self.scrap_stage = "detecting"\n')
    replace_once(root / "backend/main.py",
                 '        continuous_frame_no_list = sub_detector.find_continuous_ranges_with_same_mask(sub_list)\n'
                 '        scene_div_points = sub_detector.get_scene_div_frame_no(self.video_path)',
                 '        self.scrap_stage = "cleaning"\n'
                 '        self.progress_total = 0\n'
                 '        self.notify_progress_listeners()\n'
                 '        continuous_frame_no_list = sub_detector.find_continuous_ranges_with_same_mask(sub_list)\n'
                 '        scene_div_points = sub_detector.get_scene_div_frame_no(self.video_path)')
    # Portrait videos can otherwise produce 112px strips: RAFT's correlation
    # pyramid divides by zero below 128px. More context also helps reconstruction.
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 'split_h = int(W_ori * 3 / 16)',
                 'split_h = max(192, int(W_ori * 3 / 16))')
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 'inpaint_area = get_inpaint_area_by_mask(W_ori, H_ori, split_h, mask, multiple=8)',
                 'from vsr_runtime import get_inpaint_regions\n'
                 '        inpaint_area = get_inpaint_regions(W_ori, H_ori, split_h, mask, multiple=8)')
    replace_count(root / "backend/inpaint/propainter_inpaint.py",
                  'torch.cuda.empty_cache()', '# Reuse CUDA allocations until this job finishes.', 7)
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 '            gc.collect()', '            # Frame buffers are released by reference counting.')
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 '''        # for saving the masked frames or video
        masked_frame_for_save = []
        for i in range(len(frames)):
            mask_ = np.expand_dims(np.array(masks_dilated[i]), 2).repeat(3, axis=2) / 255.
            img = np.array(frames[i])
            green = np.zeros([h, w, 3])
            green[:, :, 1] = 255
            alpha = 0.6
            # alpha = 1.0
            fuse_img = (1 - alpha) * img + alpha * green
            fuse_img = mask_ * fuse_img + (1 - mask_) * img
            masked_frame_for_save.append(fuse_img.astype(np.uint8))
''', '        # Omit the unused debug preview; reconstruction inputs are unchanged.\n')
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 '        w, h = size\n',
                 '        w, h = size\n'
                 '        if min(w, h) < 128:\n'
                 '            raise RuntimeError("ProPainter requires crops of at least 128 pixels per side")\n')
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 '        size = frames[0].size\n',
                 '        size = frames[0].size\n'
                 '        width, height = size\n'
                 '        if min(width, height) >= 128 and (width % 8 or height % 8):\n'
                 '            pad_w, pad_h = (-width) % 8, (-height) % 8\n'
                 '            padded = [Image.fromarray(np.pad(np.asarray(frame), ((0, pad_h), (0, pad_w), (0, 0)), mode="edge")) for frame in frames]\n'
                 '            padding = ((0, pad_h), (0, pad_w)) + ((0, 0),) * (mask.ndim - 2)\n'
                 '            return [frame[:height, :width] for frame in self.inpaint(padded, np.pad(mask, padding))]\n')
    # NaN/Inf were silently cast to uint8 zeros, exporting a black mask as success.
    replace_once(root / "backend/inpaint/propainter_inpaint.py",
                 '                pred_img = (pred_img + 1) / 2\n',
                 '                if not torch.isfinite(pred_img).all().item():\n'
                 '                    raise RuntimeError("ProPainter produced invalid pixels; export refused")\n'
                 '                pred_img = ((pred_img.float() + 1) / 2).clamp(0, 1)\n')
    replace_once(root / "backend/main.py",
                 'PropainterInpaint(device, self.model_config.PROPAINTER_MODEL_DIR, config.propainterMaxLoadNum.value)',
                 'PropainterInpaint(device, self.model_config.PROPAINTER_MODEL_DIR, config.propainterMaxLoadNum.value, use_fp16=True)')
    replace_count(root / "backend/main.py",
                 'self.update_preview_with_comp(np.clip(batch[i]+mask[:,:,np.newaxis]*0.3,0,255).astype(np.uint8), inpainted_frame)',
                 'self.update_preview_with_comp(batch[i], inpainted_frame)', 2)
    replace_once(root / "backend/tools/video_io.py",
                 "'-preset', 'fast',", "'-preset', 'veryfast',\n            '-threads', '4',")


if __name__ == "__main__":
    patch(Path("/vsr"))
