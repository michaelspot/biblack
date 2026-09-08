"""Deploy: modal deploy services/scrap/modal_app.py.

Modal secret `scaylit-scrap`: COBALT_API_URL, COBALT_API_KEY,
SCRAP_SERVICE_TOKEN, R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY. Worker secrets: SCRAP_SERVICE_URL (the `web` URL)
and SCRAP_SERVICE_TOKEN (same value). ProPainter is for noncommercial use.
"""
import hmac
import os
from pathlib import Path
import tempfile
import time
import traceback

import modal

HERE = Path(__file__).parent
VSR_REVISION = "e109b9ddc1d0e8f153199dfa05c1d767546906d8"
app = modal.App("scaylit-scrap")
secret = modal.Secret.from_name("scaylit-scrap")
jobs = modal.Dict.from_name("scaylit-scrap-jobs", create_if_missing=True)
base_image = (modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("fastapi[standard]>=0.115,<1", "requests>=2.32,<3", "boto3>=1.35,<2"))
cpu_image = base_image.add_local_file(HERE / "pipeline.py", "/root/pipeline.py", copy=True)
gpu_image = (base_image
    .apt_install("git", "libgl1", "libegl1", "libxkbcommon0", "libdbus-1-3", "libglib2.0-0")
    .run_commands(
        "git clone --filter=blob:none --no-checkout https://github.com/YaoFANGUK/video-subtitle-remover.git /vsr",
        f"cd /vsr && git checkout {VSR_REVISION} -- backend requirements.txt LICENSE",
        "ln -sf /usr/bin/ffmpeg /vsr/backend/ffmpeg/linux_x64/ffmpeg",
    )
    .pip_install("torch==2.7.0", "torchvision==0.22.0", index_url="https://download.pytorch.org/whl/cu126")
    .pip_install("paddlepaddle-gpu==3.0.0", index_url="https://www.paddlepaddle.org.cn/packages/stable/cu126/")
    .pip_install("setuptools==80.4.0")
    .run_commands("pip install -r /vsr/requirements.txt")
    .env({"PYTHONPATH": "/vsr:/root", "QT_QPA_PLATFORM": "offscreen", "FLAGS_allocator_strategy": "auto_growth",
          "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True"})
    .workdir("/vsr")
    .add_local_file(HERE / "vsr_runner.py", "/root/vsr_runner.py", copy=True)
    .add_local_file(HERE / "vsr_runtime.py", "/root/vsr_runtime.py", copy=True)
    .add_local_file(HERE / "patch_vsr.py", "/root/patch_vsr.py", copy=True)
    .run_commands("python /root/patch_vsr.py")
    .run_commands("python -c 'from backend.tools.model_config import ModelConfig; ModelConfig(); from backend.main import SubtitleRemover'")
    .add_local_file(HERE / "pipeline.py", "/root/pipeline.py", copy=True))


def update_job(job_id, status, **details):
    job = jobs[job_id]
    if job["status"] != status:
        job["progress"] = 100 if status == "completed" else 0
    jobs[job_id] = {**job, "status": status, "updatedAt": int(time.time()), **details}


@app.cls(image=gpu_image, gpu="H100", cpu=4, timeout=1200, startup_timeout=300,
         max_containers=1, min_containers=0, scaledown_window=60,
         enable_memory_snapshot=True)
class VideoCleaner:
    @modal.enter(snap=True)
    def initialize(self):
        # Paddle's import queries CUDA and cannot precede a CPU snapshot.
        # Keep only PyTorch's CPU import here; load Paddle on the real GPU.
        import torch
        if torch.cuda.is_initialized():
            raise RuntimeError("CUDA must remain uninitialized before the CPU snapshot")

    @modal.enter()
    def load_models(self):
        from vsr_runtime import prepare_runtime
        from backend.main import SubtitleRemover
        from backend.tools.hardware_accelerator import HardwareAccelerator
        prepare_runtime()
        HardwareAccelerator.instance()

    @modal.method()
    def ready(self):
        return True

    @modal.method()
    def remove_text(self, job_id, video_bytes):
        from vsr_runner import clean_video
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="scrap-gpu-") as directory:
            source = Path(directory) / "original.mp4"
            cleaned = Path(directory) / "cleaned.mp4"
            # Modal transports large arguments through its own storage. This
            # avoids uploading the source to R2 and downloading it again.
            source.write_bytes(video_bytes)
            prepared = time.monotonic()
            stages = {}
            def progress(stage, percentage):
                stages.setdefault(stage, time.monotonic())
                update_job(job_id, stage, progress=percentage)
            note = clean_video(source, cleaned, progress)
            cleaned_at = time.monotonic()
            update_job(job_id, "exporting")
            timings = {"inputSeconds": round(prepared - started, 2), "cleanSeconds": round(cleaned_at - prepared, 2),
                       "detectionSeconds": round(stages.get("cleaning", cleaned_at) - stages.get("detecting", prepared), 2)}
            print({"job": job_id, **timings}, flush=True)
            return {"video": cleaned.read_bytes(), "timings": timings, **({"note": note} if note else {})}


@app.function(image=cpu_image, cpu=2, memory=1024, region="us-east", secrets=[secret], timeout=1500, max_containers=2)
def process_video(job_id, source_url, should_remove_text):
    from pipeline import download_video, normalize, finish_clean_video, r2_client, upload, ScrapError, TTL
    try:
        started = time.monotonic()
        cleaner = VideoCleaner() if should_remove_text else None
        # Restore GPU/model state while Cobalt downloads on the CPU worker.
        if cleaner:
            cleaner.ready.spawn()
        with tempfile.TemporaryDirectory(prefix="scrap-cpu-") as directory:
            source = Path(directory) / "download.mp4"
            normalized = Path(directory) / "original.mp4"
            update_job(job_id, "downloading")
            download_video(source_url, source)
            normalize(source, normalized, should_remove_text)
            if should_remove_text:
                update_job(job_id, "detecting")
                result = cleaner.remove_text.remote(job_id, normalized.read_bytes())
                exporting = time.monotonic()
                cleaned, final = Path(directory) / "cleaned.mp4", Path(directory) / "final.mp4"
                cleaned.write_bytes(result.pop("video"))
                finish_clean_video(cleaned, normalized, final)
            else:
                update_job(job_id, "exporting")
                exporting = time.monotonic()
                result, final = {}, normalized
            key = f"scrap/results/{job_id}.mp4"
            expires_at = int(time.time()) + TTL
            upload(r2_client(), final, key, expires_at)
            result.update(key=key, expiresAt=expires_at)
            result.setdefault("timings", {})["exportSeconds"] = round(time.monotonic() - exporting, 2)
            result.setdefault("timings", {})["totalSeconds"] = round(time.monotonic() - started, 2)
            update_job(job_id, "completed", **result)
    except Exception as error:
        traceback.print_exc()
        message = str(error) if isinstance(error, ScrapError) else "Le traitement vidéo a échoué. Réessaie avec une vidéo plus courte."
        update_job(job_id, "failed", error=message)


@app.function(image=cpu_image, secrets=[secret], timeout=60)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from pipeline import JOB_ID, validate_request, ScrapError
    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.middleware("http")
    async def authenticate(request: Request, call_next):
        expected = os.environ.get("SCRAP_SERVICE_TOKEN", "")
        if not expected or not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {expected}"):
            return JSONResponse({"error": "Accès refusé."}, status_code=401)
        return await call_next(request)

    @api.post("/jobs")
    async def create(request: Request):
        try:
            raw = await request.body()
            if len(raw) > 4096:
                return JSONResponse({"error": "Requête trop volumineuse."}, status_code=413)
            import json
            body = validate_request(json.loads(raw))
        except (ValueError, ScrapError):
            return JSONResponse({"error": "Lien ou paramètres Scrap invalides."}, status_code=400)
        job_id = body["id"]
        initial = {"id": job_id, "status": "queued", "sourceUrl": body["url"], "removeText": body["removeText"], "createdAt": int(time.time())}
        # Atomic claim prevents a retry after a network interruption from paying twice.
        added = await jobs.put.aio(job_id, initial, skip_if_exists=True)
        if added:
            try:
                await process_video.spawn.aio(job_id, body["url"], body["removeText"])
            except Exception:
                await jobs.put.aio(job_id, {**initial, "status": "failed", "error": "Le traitement n’a pas pu démarrer. Relance la vidéo."})
        current = await jobs.get.aio(job_id)
        if current["sourceUrl"] != body["url"] or current["removeText"] != body["removeText"]:
            return JSONResponse({"error": "Cet identifiant correspond à une autre vidéo."}, status_code=409)
        return current

    @api.get("/jobs/{job_id}")
    async def status(job_id: str):
        if not JOB_ID.fullmatch(job_id):
            return JSONResponse({"error": "Identifiant invalide."}, status_code=400)
        current = await jobs.get.aio(job_id)
        if not current:
            return JSONResponse({"error": "Ce traitement est introuvable. Relance le lien."}, status_code=404)
        if current.get("expiresAt", float("inf")) <= time.time():
            return JSONResponse({"error": "Cette vidéo a expiré. Relance le lien."}, status_code=410)
        if current["status"] not in ("failed", "completed") and time.time() - current["createdAt"] > 3600:
            return {**current, "status": "failed", "error": "Le traitement a dépassé son délai. Relance une vidéo plus courte."}
        return current

    return api


@app.function(image=cpu_image, secrets=[secret], schedule=modal.Period(hours=1), timeout=600)
def cleanup():
    from pipeline import r2_client, TTL
    client = r2_client()
    bucket = os.environ["R2_BUCKET_NAME"]
    cutoff = time.time() - TTL
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="scrap/"):
        expired = [{"Key": item["Key"]} for item in page.get("Contents", []) if item["LastModified"].timestamp() < cutoff]
        if expired:
            client.delete_objects(Bucket=bucket, Delete={"Objects": expired})
