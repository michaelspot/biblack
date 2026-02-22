import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import fs from "fs";
import https from "https";
import path from "path";
import ANTON_BASE64 from "./font-anton.js";

// Enregistrer la font Anton au démarrage
GlobalFonts.register(Buffer.from(ANTON_BASE64, 'base64'), 'Anton');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const publicBaseUrl = "https://pub-f14155236ed54ea8847eb4db5d3c64c1.r2.dev";

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

function wrapText(text, maxChars = 20) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length > maxChars && currentLine) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += ' ' + word;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines;
}

function createTextOverlay(text, outputPath) {
  const cleanText = stripEmojis(text);
  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext('2d');

  const lines = wrapText(cleanText, 20);
  const lineHeight = 90;
  const totalHeight = lines.length * lineHeight;
  const startY = 960 - totalHeight / 2 + lineHeight / 2;

  ctx.font = '75px Anton';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Stroke noir (bordure épaisse)
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 8;
  ctx.lineJoin = 'round';
  for (let i = 0; i < lines.length; i++) {
    ctx.strokeText(lines[i], 540, startY + i * lineHeight);
  }

  // Fill blanc
  ctx.fillStyle = 'white';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 540, startY + i * lineHeight);
  }

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
}

export default async function handler(req, res) {
  const { hook, capture, musique, texte } = req.query;

  if (!hook || !capture) {
    return res.status(400).json({ error: "Il manque le hook ou la capture." });
  }

  const timestamp = Date.now() + Math.random().toString(36).slice(2, 6);
  const hookPath = `/tmp/hook-${timestamp}${path.extname(hook)}`;
  const capturePath = `/tmp/capture-${timestamp}${path.extname(capture)}`;
  const musiquePath = musique ? `/tmp/musique-${timestamp}${path.extname(musique)}` : null;
  const overlayPath = texte ? `/tmp/overlay-${timestamp}.png` : null;
  const outputPath = `/tmp/output-${timestamp}.mp4`;
  const tempFiles = [hookPath, capturePath, outputPath];
  if (musiquePath) tempFiles.push(musiquePath);
  if (overlayPath) tempFiles.push(overlayPath);

  try {
    // Télécharge les fichiers en parallèle + génère le text overlay
    const tasks = [
      downloadFile(`${publicBaseUrl}/hooks/${hook}`, hookPath),
      downloadFile(`${publicBaseUrl}/captures/${capture}`, capturePath),
    ];
    if (musique) {
      tasks.push(downloadFile(`${publicBaseUrl}/musique/${musique}`, musiquePath));
    }
    if (texte) {
      createTextOverlay(texte, overlayPath);
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
      const overlayIdx = musiquePath ? 3 : 2;
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

    // Upload vers R2
    const fileName = `montages/bulk-${timestamp}.mp4`;
    const fileStream = fs.createReadStream(outputPath);
    const fileSize = fs.statSync(outputPath).size;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: fileStream,
      ContentLength: fileSize,
      ContentType: "video/mp4",
    }));

    // Nettoie
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    res.status(200).json({
      message: "Vidéo générée !",
      url: `${publicBaseUrl}/${fileName}`,
    });

  } catch (error) {
    console.error("Bulk merge error:", error);
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    res.status(400).json({ error: error.message });
  }
}
