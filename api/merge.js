import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import fs from "fs";
import https from "https";
import path from "path";

// Configuration de FFmpeg et FFprobe
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

// Télécharge un fichier depuis une URL
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode === 404) {
        fs.unlinkSync(destPath);
        reject(new Error(`Fichier introuvable: ${url}`));
        return;
      }
      if (response.statusCode !== 200) {
        fs.unlinkSync(destPath);
        reject(new Error(`Erreur HTTP ${response.statusCode} pour ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

export default async function handler(req, res) {
  const { hook, capture, hookPrefix } = req.query;

  if (!hook || !capture) {
    return res.status(400).json({ error: "Il manque le hook ou la capture." });
  }

  // Par défaut hooks-snapchat si pas de préfixe spécifié
  const prefix = hookPrefix || "hooks-snapchat/";

  const timestamp = Date.now();
  const hookPath = `/tmp/hook-${timestamp}${path.extname(hook)}`;
  const capturePath = `/tmp/capture-${timestamp}${path.extname(capture)}`;
  const outputPath = `/tmp/output-${timestamp}.mp4`;

  try {
    // Télécharge les deux fichiers en parallèle
    console.log("Téléchargement des fichiers...");
    await Promise.all([
      downloadFile(`${publicBaseUrl}/${prefix}${hook}`, hookPath),
      downloadFile(`${publicBaseUrl}/captures/${capture}`, capturePath),
    ]);
    console.log("Fichiers téléchargés");

    // Filtre de base (drawtext non dispo dans ffmpeg-static)
    const filterComplex = [
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]",
      "[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]",
      "[v0][v1]concat=n=2:v=1:a=0[outv]"
    ];

    // Fusionne les vidéos
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(hookPath)
        .input(capturePath)
        .on("start", (cmd) => console.log("FFmpeg command:", cmd))
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(err);
        })
        .on("end", () => {
          console.log("Fusion terminée");
          resolve();
        })
        .complexFilter(filterComplex)
        .outputOptions([
          "-map", "[outv]",
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "18",
          "-movflags", "+faststart",
          "-an"
        ])
        .output(outputPath)
        .run();
    });

    // Vérifie que le fichier existe
    if (!fs.existsSync(outputPath)) {
      throw new Error("Le fichier de sortie n'a pas été créé.");
    }

    // Upload vers R2
    console.log("Upload vers R2...");
    const fileBuffer = fs.readFileSync(outputPath);
    const fileName = `montages/final-${timestamp}.mp4`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: fileBuffer,
      ContentType: "video/mp4",
    }));

    // Nettoie les fichiers temporaires
    [hookPath, capturePath, outputPath].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    console.log("Terminé!");
    res.status(200).json({
      message: "Vidéo générée !",
      url: `${publicBaseUrl}/${fileName}`
    });

  } catch (error) {
    console.error("Error:", error);

    // Nettoie les fichiers temporaires en cas d'erreur
    [hookPath, capturePath, outputPath].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    let errorMsg = error.message;
    if (error.message.includes("introuvable")) {
      if (error.message.includes("/hooks-")) {
        errorMsg = `Fichier hook "${hook}" introuvable dans le dossier "${prefix}". Vérifie que le fichier existe.`;
      } else if (error.message.includes("/captures/")) {
        errorMsg = `Fichier capture "${capture}" introuvable. Vérifie que le fichier existe.`;
      }
    } else if (error.message.includes("FFmpeg") || error.message.includes("ffmpeg")) {
      errorMsg = `Erreur lors du montage vidéo. Le format des fichiers est peut-être incompatible.`;
    } else if (error.message.includes("sortie n'a pas été créé")) {
      errorMsg = `Le montage a échoué. Vérifie que les fichiers vidéo sont valides.`;
    }

    res.status(400).json({ error: errorMsg });
  }
}
