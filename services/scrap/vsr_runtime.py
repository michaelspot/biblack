"""Reusable CUDA models and bounded text crops for the headless VSR worker."""
from functools import lru_cache


@lru_cache(maxsize=1)
def get_text_detector(**options):
    from paddleocr import TextDetection
    return TextDetection(**options)


@lru_cache(maxsize=1)
def get_propainter_model(device, model_dir, sub_video_length=30, use_fp16=True):
    from backend.inpaint.propainter_inpaint import PropainterInpaint
    model = PropainterInpaint(device, model_dir, sub_video_length, use_fp16=use_fp16)
    model.raft_iter = 12
    return model


def get_inpaint_regions(width, height, strip_height, mask, multiple=8):
    import cv2
    import numpy as np
    from backend.tools.inpaint_tools import get_inpaint_area_by_mask
    binary = np.any(mask > 0, axis=2) if mask.ndim == 3 else mask > 0
    _, _, stats, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    text_height = max((int(row[cv2.CC_STAT_HEIGHT]) for row in stats[1:]
                       if row[cv2.CC_STAT_AREA] >= 10), default=0)
    strip_height = min(height, max(192, strip_height, text_height + 64))
    regions = get_inpaint_area_by_mask(width, height, strip_height, mask, multiple)
    # Separate caption lines often produce overlapping strips. Rebuild
    # their shared context once, while keeping distant captions independent.
    merged = []
    limit = strip_height * 3 // 2
    for top, bottom, left, right in sorted(regions):
        if merged and top < merged[-1][1] and max(bottom, merged[-1][1]) - merged[-1][0] <= limit:
            previous = merged.pop()
            merged.append((previous[0], max(previous[1], bottom), 0, width))
        else:
            merged.append((top, bottom, left, right))
    result = []
    for top, bottom, left, right in merged:
        band = mask[top:bottom]
        axes = tuple(axis for axis in range(band.ndim) if axis != 1)
        columns = np.flatnonzero(np.any(band > 0, axis=axes))
        if len(columns):
            # Keep real surrounding pixels and RAFT's minimum 128px dimension.
            left = max(0, (int(columns[0]) - 64) // 8 * 8)
            right = min(width, (int(columns[-1]) + 65 + 7) // 8 * 8)
            if right - left < 128:
                left = max(0, min(left, width - 128))
                right = min(width, left + 128)
        result.append((top, bottom, left, right))
    return result


@lru_cache(maxsize=1)
def prepare_runtime():
    import cv2
    import numpy as np
    import paddle
    import torch
    from backend.config import config
    from backend.tools.constant import InpaintMode, SubtitleDetectMode
    from backend.tools.model_config import ModelConfig

    if not torch.cuda.is_available() or not paddle.is_compiled_with_cuda():
        raise RuntimeError("Le traitement Scrap nécessite CUDA pour ProPainter et la détection")
    torch.set_num_threads(4)
    cv2.setNumThreads(2)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    config.inpaintMode.value = InpaintMode.PROPAINTER
    config.subtitleDetectMode.value = SubtitleDetectMode.PP_OCRv5_MOBILE
    config.propainterMaxLoadNum.value = 30
    config.hardwareAcceleration.value = True
    config.checkUpdateOnStartup.value = False
    model_config = ModelConfig()
    detector = get_text_detector(model_name=model_config.DET_MODEL_NAME,
                                 model_dir=model_config.DET_MODEL_DIR,
                                 device="gpu:0", enable_hpi=False)
    frame = np.full((1024, 576, 3), 120, dtype=np.uint8)
    cv2.putText(frame, "Scrap", (120, 270), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
    list(detector.predict(frame))
    model = get_propainter_model(torch.device("cuda:0"), model_config.PROPAINTER_MODEL_DIR, 30, use_fp16=True)
    mask = np.zeros((1024, 576), dtype=np.uint8)
    mask[240:280, 115:225] = 255
    model([frame.copy() for _ in range(12)], mask)
    # Keep model weights and warmed libraries; release disposable warmup buffers.
    torch.cuda.synchronize()
    paddle.device.cuda.synchronize()
    torch.cuda.empty_cache()
    paddle.device.cuda.empty_cache()
