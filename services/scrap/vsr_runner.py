"""Headless adapter for pinned VSR + ProPainter (noncommercial model license)."""
import os
from pathlib import Path
import shutil
import time


class StageProgress:
    """VSR uses 0–50 during detection and 0–100 during inpainting."""
    def __init__(self, callback, clock=time.monotonic):
        self.callback = callback
        self.clock = clock
        self.stage = None
        self.percentage = None
        self.last_sent = float("-inf")

    def update(self, stage, value):
        percentage = max(0, min(100, int(value * (2 if stage == "detecting" else 1))))
        now = self.clock()
        if stage != self.stage or (percentage != self.percentage and (now - self.last_sent >= 2 or percentage == 100)):
            self.callback(stage, percentage)
            self.stage, self.percentage, self.last_sent = stage, percentage, now


def clean_video(source, destination, progress):
    from backend.config import tr
    from backend.main import SubtitleRemover
    from vsr_runtime import prepare_runtime

    prepare_runtime()
    remover = SubtitleRemover(str(source))
    remover.sub_areas = []  # VSR scans the entire image; no mask to draw on the phone.
    remover.video_out_path = str(destination)
    # VSR already writes H.264. Keep it and attach original audio once, downstream.
    remover.merge_audio_to_video = lambda: shutil.copyfile(remover.video_temp_file.name, destination)
    reporter = StageProgress(progress)
    remover.add_progress_listener(lambda percentage, _finished: reporter.update(getattr(remover, "scrap_stage", "detecting"), percentage))
    reporter.update("detecting", 0)
    try:
        try:
            remover.run()
        except Exception as error:
            # No detected text is a successful original video, never fake inpainting.
            if str(error) != tr['Main']['NoSubtitleDetected'].format(str(source)):
                raise
            shutil.copyfile(source, destination)
            return "Aucun texte détecté · vidéo conservée telle quelle"
        if not remover.isFinished or not Path(destination).is_file():
            raise RuntimeError("VSR n’a pas terminé le traitement")
        return None
    finally:
        remover.video_cap.release()
        remover.video_writer.release()
        remover.video_temp_file.close()
        if os.path.exists(remover.video_temp_file.name):
            os.remove(remover.video_temp_file.name)
