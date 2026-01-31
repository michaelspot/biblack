import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import fs from "fs";
import https from "https";

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
        reject(new Error(`HTTP ${response.statusCode}`));
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
  const { type, filename } = req.query;

  if (!type || !filename) return res.status(400).json({ error: "Paramètres manquants" });
  if (!["hook", "capture"].includes(type)) return res.status(400).json({ error: "Type invalide" });

  const folder = type === "hook" ? "hooks" : "captures";
  const posterKey = `posters/${folder}/${filename}.jpg`;

  // Check if poster already exists on R2
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: posterKey,
    }));
    // Poster exists, redirect to R2 CDN
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.redirect(302, `${publicBaseUrl}/${posterKey}`);
  } catch (e) {
    // Poster doesn't exist, generate it
  }

  const videoUrl = `${publicBaseUrl}/${folder}/${filename}`;
  const timestamp = Date.now();
  const videoPath = `/tmp/pv-${timestamp}${filename.substring(filename.lastIndexOf("."))}`;
  const posterPath = `/tmp/poster-${timestamp}.jpg`;

  try {
    await downloadFile(videoUrl, videoPath);

    // Extract a single frame at low resolution
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(0.1)
        .frames(1)
        .videoFilter("scale=320:-1")
        .outputOptions(["-q:v", "10"])
        .output(posterPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    const posterBuffer = fs.readFileSync(posterPath);

    // Cache on R2
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: posterKey,
      Body: posterBuffer,
      ContentType: "image/jpeg",
    }));

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(posterBuffer);
  } catch (error) {
    console.error("Poster error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    [videoPath, posterPath].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  }
}

export const config = {
  maxDuration: 30,
};
