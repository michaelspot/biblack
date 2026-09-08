"""CPU helpers for Cobalt download, MP4 validation and temporary R2 storage."""
import json
import math
import os
from pathlib import Path
import re
from fractions import Fraction
import subprocess
import time
from urllib.parse import urlparse

MAX_BYTES = 250 * 1024 * 1024
TTL = 24 * 60 * 60
JOB_ID = re.compile(r"[a-z0-9-]{24,80}\Z")
SOCIAL_HOSTS = {"tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "instagram.com", "www.instagram.com"}


class ScrapError(Exception):
    pass


def validate_request(body):
    if not isinstance(body, dict) or not isinstance(body.get("id"), str) or not JOB_ID.fullmatch(body["id"]):
        raise ScrapError("Identifiant Scrap invalide.")
    source = body.get("url")
    if not isinstance(source, str) or len(source) > 2048 or type(body.get("removeText")) is not bool:
        raise ScrapError("Paramètres Scrap invalides.")
    try:
        url = urlparse(source)
        if url.scheme != "https" or url.hostname not in SOCIAL_HOSTS or url.username or url.password or url.port or url.path in ("", "/"):
            raise ValueError()
    except ValueError:
        raise ScrapError("Colle le lien HTTPS d’une vidéo TikTok ou Instagram.")
    return {"id": body["id"], "url": source, "removeText": body["removeText"]}


def cobalt_tunnel(data, endpoint):
    if not isinstance(data, dict):
        raise ScrapError("Réponse Cobalt invalide.")
    if data.get("status") == "picker":
        raise ScrapError("Ce lien contient un album. Colle le lien d’une seule vidéo.")
    if data.get("status") == "error":
        raise ScrapError("Cobalt n’a pas pu récupérer cette vidéo. Vérifie qu’elle est publique et que le lien est accessible.")
    # alwaysProxy + localProcessing=disabled guarantees a single, trusted tunnel.
    if data.get("status") != "tunnel" or not isinstance(data.get("url"), str):
        raise ScrapError("Cobalt n’a pas renvoyé de vidéo téléchargeable. Vérifie la configuration de l’instance.")
    target, base = urlparse(data["url"]), urlparse(endpoint)
    if target.scheme != "https" or target.netloc != base.netloc or target.username or target.password or target.path != "/tunnel":
        raise ScrapError("Le lien de téléchargement Cobalt n’est pas autorisé.")
    return data["url"]


def download_video(source, destination):
    import requests
    endpoint = os.environ["COBALT_API_URL"]
    base = urlparse(endpoint)
    if base.scheme != "https" or not base.netloc or base.username or base.password or base.query or base.fragment:
        raise ScrapError("L’adresse Cobalt doit être une URL HTTPS valide.")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if os.environ.get("COBALT_API_KEY"):
        headers["Authorization"] = f"Api-Key {os.environ['COBALT_API_KEY']}"
    response = requests.post(endpoint, headers=headers, json={
        "url": source, "downloadMode": "auto", "videoQuality": "1080",
        "alwaysProxy": True, "localProcessing": "disabled", "allowH265": False,
    }, timeout=(10, 60), allow_redirects=False)
    if response.status_code != 200:
        raise ScrapError("Téléchargement indisponible. Vérifie le lien et l’accès à l’instance Cobalt.")
    tunnel = cobalt_tunnel(response.json(), endpoint)
    started = time.monotonic()
    with requests.get(tunnel, stream=True, timeout=(10, 45), allow_redirects=False) as video:
        if video.status_code != 200:
            raise ScrapError("Le téléchargement de la vidéo a été refusé. Réessaie avec un lien public.")
        if int(video.headers.get("Content-Length", 0)) > MAX_BYTES:
            raise ScrapError("Cette vidéo dépasse la limite de 250 Mo.")
        total = 0
        with open(destination, "wb") as output:
            for chunk in video.iter_content(1024 * 1024):
                total += len(chunk)
                if total > MAX_BYTES or time.monotonic() - started > 180:
                    raise ScrapError("Vidéo trop volumineuse ou téléchargement trop lent (250 Mo maximum).")
                output.write(chunk)
    if not total:
        raise ScrapError("La vidéo téléchargée est vide.")


def run(command, timeout=600):
    try:
        return subprocess.run(command, check=True, capture_output=True, timeout=timeout).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ScrapError("La vidéo n’a pas pu être convertie. Essaie un autre lien ou une vidéo plus courte.") from error


def probe(source):
    data = json.loads(run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
        "-show_streams", "-show_format", "-of", "json", str(source),
    ], timeout=30))
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    if not video:
        raise ScrapError("Ce lien ne contient pas de vidéo.")
    try:
        duration = float(data.get("format", {}).get("duration", 0))
        pixels = int(video.get("width", 0)) * int(video.get("height", 0))
    except (TypeError, ValueError):
        raise ScrapError("Les informations de cette vidéo sont illisibles.")
    if not math.isfinite(duration) or duration <= 0 or pixels <= 0 or pixels > 3840 * 2160:
        raise ScrapError("Le format ou la résolution de cette vidéo n’est pas pris en charge.")
    audio = next((s for s in data["streams"] if s.get("codec_type") == "audio"), None)
    def rate(value):
        try:
            return float(Fraction(value))
        except (ValueError, ZeroDivisionError, TypeError):
            return 0
    rotations = [side.get("rotation", 0) for side in video.get("side_data_list", [])]
    rotations.append(video.get("tags", {}).get("rotate", 0))
    return {"duration": duration, "audio": audio is not None,
            "width": int(video["width"]), "height": int(video["height"]),
            "fps": rate(video.get("r_frame_rate", "0")), "averageFps": rate(video.get("avg_frame_rate", "0")),
            "videoCodec": video.get("codec_name"), "pixelFormat": video.get("pix_fmt"),
            "audioCodec": audio.get("codec_name") if audio else None,
            "squarePixels": video.get("sample_aspect_ratio", "1:1") in ("1:1", "0:1", "N/A"),
            "rotated": any(str(value) not in ("0", "0.0", "-0.0") for value in rotations)}


def normalize(source, destination, remove_text):
    info = probe(source)
    limit = 180 if remove_text else 600
    if info["duration"] > limit:
        raise ScrapError(f"Limite de {limit // 60} minutes {'avec' if remove_text else 'sans'} suppression du texte.")
    # Bound ProPainter memory and keep portrait/landscape proportions, without upscaling.
    edge = 1280 if remove_text else 1920
    compatible = (info["videoCodec"] == "h264" and info["pixelFormat"] == "yuv420p"
                  and info["audioCodec"] in (None, "aac") and info["squarePixels"] and not info["rotated"]
                  and max(info["width"], info["height"]) <= edge
                  and info["width"] % 2 == 0 and info["height"] % 2 == 0
                  and (not remove_text or (0 < info["fps"] <= 30.01 and abs(info["averageFps"] - info["fps"]) < 0.01)))
    if compatible:
        # Remux compatible source packets without a lossy decode/encode cycle.
        run(["ffmpeg", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
             "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", str(destination)])
        verify_result(destination, info)
        return
    filters = f"scale=w='min(iw,{edge})':h='min(ih,{edge})':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    if remove_text:
        filters += ",fps=fps='min(source_fps,30)'"
    run(["ffmpeg", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", str(source),
         "-map", "0:v:0", "-map", "0:a:0?", "-vf", filters, "-c:v", "libx264", "-preset", "veryfast", "-threads", "4", "-crf", "18",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(destination)])
    verify_result(destination, info)


def verify_result(path, source_info):
    if not Path(path).is_file() or Path(path).stat().st_size < 100:
        raise ScrapError("Le traitement n’a pas produit de vidéo.")
    result = probe(path)
    if abs(result["duration"] - source_info["duration"]) > 0.5 or (source_info["audio"] and not result["audio"]):
        raise ScrapError("Le résultat est incomplet ou son audio est manquant. Relance le traitement.")


def r2_client():
    import boto3
    from botocore.config import Config
    return boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], region_name="auto",
                        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                        config=Config(connect_timeout=5, read_timeout=30, retries={"mode": "standard", "total_max_attempts": 3}))


def upload(client, source, key, expires_at):
    client.upload_file(str(source), os.environ["R2_BUCKET_NAME"], key, ExtraArgs={
        "ContentType": "video/mp4", "CacheControl": "private, no-store", "Metadata": {"expiresat": str(expires_at)},
    })


def finish_clean_video(cleaned, original, destination):
    # Always remux the original audio ourselves, including videos with no audio.
    output_info, source_info = probe(cleaned), probe(original)
    video_options = (["-c:v", "copy"] if output_info["videoCodec"] == "h264" and output_info["pixelFormat"] == "yuv420p"
                     else ["-c:v", "libx264", "-preset", "veryfast", "-threads", "4", "-crf", "18", "-pix_fmt", "yuv420p"])
    audio_options = ["-c:a", "copy"] if source_info["audioCodec"] in (None, "aac") else ["-c:a", "aac", "-b:a", "192k"]
    run(["ffmpeg", "-y", "-v", "error", "-i", str(cleaned), "-i", str(original),
         "-map", "0:v:0", "-map", "1:a:0?", *video_options, *audio_options, "-movflags", "+faststart", str(destination)])
    verify_result(destination, source_info)
