import cloudinary from './_cloudinary.js';
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import fs from "fs";
import https from "https";
import path from "path";
import TIKTOK_BASE64 from "./font-tiktok.js";

// Enregistrer la font TikTok Sans Medium au démarrage
GlobalFonts.register(Buffer.from(TIKTOK_BASE64, 'base64'), 'TikTokSans');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        fs.unlinkSync(destPath);
        reject(new Error(`Erreur HTTP ${response.statusCode} pour ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

function stripEmojis(text) {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').replace(/\s+/g, ' ').trim();
}

function createTextOverlay(text, outputPath, positionPercent = 50) {
  const cleanText = stripEmojis(text);
  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext('2d');

  // Safe zone TikTok : Y de 7% à 75%
  // 7%-45% : X de 8% à 92% → centre 540px, largeur 907px
  // 45%-75% : X de 8% à 82% → centre 486px, largeur 799px
  const safeTop = Math.round(1920 * 0.07);     // 134px
  const safeBottom = Math.round(1920 * 0.75);   // 1440px
  const narrowStart = Math.round(1920 * 0.45);  // 864px

  const pos = Math.max(0, Math.min(100, Number(positionPercent)));

  ctx.font = '500 54px TikTokSans';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Déterminer la zone selon la position Y estimée
  const lineHeight = 48;
  const estimatedHeight = 3 * lineHeight;
  const estimatedRange = safeBottom - safeTop - estimatedHeight;
  const estimatedStartY = safeTop + (estimatedRange * pos / 100);
  const estimatedBottomY = estimatedStartY + estimatedHeight;
  const inNarrowZone = estimatedBottomY > narrowStart;
  const maxWidth = inNarrowZone ? 799 : 907;
  const centerX = inNarrowZone ? 486 : 540;

  // Retours à la ligne : après "et", et sur double espace
  const prepared = cleanText.replace(/\s{2,}/g, '\n');
  const segments = prepared.split('\n').map(s => s.trim()).filter(Boolean);
  const lines = [];
  for (const segment of segments) {
    const words = segment.split(' ');
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      if (ctx.measureText(testLine).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  const displayLines = lines.slice(0, 3);

  const totalHeight = displayLines.length * lineHeight;

  // Position Y basée sur le slider (0=haut safe zone, 100=bas safe zone)
  const finalRange = safeBottom - safeTop - totalHeight;
  const startY = safeTop + (finalRange * pos / 100) + lineHeight / 2;

  // Bordure noire
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 8;
  ctx.lineJoin = 'round';
  for (let i = 0; i < displayLines.length; i++) {
    ctx.strokeText(displayLines[i], centerX, startY + i * lineHeight);
  }

  // Fill blanc
  ctx.fillStyle = 'white';
  for (let i = 0; i < displayLines.length; i++) {
    ctx.fillText(displayLines[i], centerX, startY + i * lineHeight);
  }

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
}

export default async function handler(req, res) {
  const { hookUrl, captureUrl, musiqueUrl, texte, textY } = req.query;

  if (!hookUrl || !captureUrl) {
    return res.status(400).json({ error: "Il manque le hook ou la capture." });
  }

  const timestamp = Date.now() + Math.random().toString(36).slice(2, 6);
  const hookPath = `/tmp/hook-${timestamp}.mp4`;
  const capturePath = `/tmp/capture-${timestamp}.mp4`;
  const musiquePath = musiqueUrl ? `/tmp/musique-${timestamp}.mp3` : null;
  const overlayPath = texte ? `/tmp/overlay-${timestamp}.png` : null;
  const outputPath = `/tmp/output-${timestamp}.mp4`;
  const tempFiles = [hookPath, capturePath, outputPath];
  if (musiquePath) tempFiles.push(musiquePath);
  if (overlayPath) tempFiles.push(overlayPath);

  try {
    // Télécharge les fichiers en parallèle + génère le text overlay
    const tasks = [
      downloadFile(hookUrl, hookPath),
      downloadFile(captureUrl, capturePath),
    ];
    if (musiqueUrl) {
      tasks.push(downloadFile(musiqueUrl, musiquePath));
    }
    if (texte) {
      createTextOverlay(texte, overlayPath, textY);
    }
    await Promise.all(tasks);

    // Construit le filtre FFmpeg
    const filterParts = [
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]",
      "[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]",
      "[v0][v1]concat=n=2:v=1:a=0[concatv]",
    ];

    let finalVideoLabel = "concatv";

    // Overlay du texte en PNG transparent
    if (texte) {
      // L'index de l'input overlay dépend de si la musique est présente
      const overlayIdx = musiqueUrl ? 3 : 2;
      filterParts.push(
        `[concatv][${overlayIdx}:v]overlay=0:0[outv]`
      );
      finalVideoLabel = "outv";
    }

    const outputOptions = [
      "-map", `[${finalVideoLabel}]`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-movflags", "+faststart",
      "-threads", "0",
    ];

    // Audio : musique ou silence
    if (musiquePath) {
      const audioIdx = 2;
      outputOptions.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "128k", "-shortest");
    } else {
      outputOptions.push("-an");
    }

    const cmd = ffmpeg().input(hookPath).input(capturePath);
    if (musiquePath) cmd.input(musiquePath);
    if (overlayPath) cmd.input(overlayPath);

    await new Promise((resolve, reject) => {
      cmd
        .complexFilter(filterParts)
        .outputOptions(outputOptions)
        .output(outputPath)
        .on("start", (cmdStr) => console.log("FFmpeg:", cmdStr))
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error("Le fichier de sortie n'a pas été créé.");
    }

    // Upload vers Cloudinary
    const uploadResult = await cloudinary.uploader.upload(outputPath, {
      folder: 'montages',
      resource_type: 'video',
      public_id: `bulk-${timestamp}`,
    });

    // Nettoie
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    res.status(200).json({
      message: "Vidéo générée !",
      url: uploadResult.secure_url,
    });

  } catch (error) {
    console.error("Bulk merge error:", error);
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    res.status(400).json({ error: error.message });
  }
}
