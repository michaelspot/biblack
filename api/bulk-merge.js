import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import fs from "fs";
import https from "https";
import path from "path";

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

export default async function handler(req, res) {
  const { hook, capture, musique, texte } = req.query;

  if (!hook || !capture) {
    return res.status(400).json({ error: "Il manque le hook ou la capture." });
  }

  const timestamp = Date.now() + Math.random().toString(36).slice(2, 6);
  const hookPath = `/tmp/hook-${timestamp}${path.extname(hook)}`;
  const capturePath = `/tmp/capture-${timestamp}${path.extname(capture)}`;
  const musiquePath = musique ? `/tmp/musique-${timestamp}${path.extname(musique)}` : null;
  const textFilePath = texte ? `/tmp/text-${timestamp}.txt` : null;
  const outputPath = `/tmp/output-${timestamp}.mp4`;
  const tempFiles = [hookPath, capturePath, outputPath];
  if (musiquePath) tempFiles.push(musiquePath);
  if (textFilePath) tempFiles.push(textFilePath);

  try {
    // Télécharge les fichiers en parallèle
    const downloads = [
      downloadFile(`${publicBaseUrl}/hooks/${hook}`, hookPath),
      downloadFile(`${publicBaseUrl}/captures/${capture}`, capturePath),
    ];
    if (musique) {
      downloads.push(downloadFile(`${publicBaseUrl}/musique/${musique}`, musiquePath));
    }
    await Promise.all(downloads);

    // Écrit le texte dans un fichier pour éviter les problèmes d'échappement
    if (texte) {
      fs.writeFileSync(textFilePath, texte);
    }

    // Construit le filtre FFmpeg
    const filterParts = [
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]",
      "[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]",
      "[v0][v1]concat=n=2:v=1:a=0[concatv]",
    ];

    let finalVideoLabel = "concatv";

    if (texte) {
      filterParts.push(
        `[concatv]drawtext=textfile='${textFilePath}':fontsize=60:fontcolor=white:borderw=3:bordercolor=black:x=(w-tw)/2:y=(h-th)/2[outv]`
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

    if (musiquePath) {
      outputOptions.push("-map", "2:a", "-c:a", "aac", "-b:a", "128k", "-shortest");
    } else {
      outputOptions.push("-an");
    }

    const cmd = ffmpeg().input(hookPath).input(capturePath);
    if (musiquePath) cmd.input(musiquePath);

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
