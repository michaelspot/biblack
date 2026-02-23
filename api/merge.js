import cloudinary from './_cloudinary.js';
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import fs from "fs";
import https from "https";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

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
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

export default async function handler(req, res) {
  const { hook, capture } = req.query;

  if (!hook || !capture) {
    return res.status(400).json({ error: "Il manque le hook ou la capture." });
  }

  const timestamp = Date.now();
  const hookPath = `/tmp/hook-${timestamp}${path.extname(hook)}`;
  const capturePath = `/tmp/capture-${timestamp}${path.extname(capture)}`;
  const outputPath = `/tmp/output-${timestamp}.mp4`;
  const concatListPath = `/tmp/concat-${timestamp}.txt`;
  const tempFiles = [hookPath, capturePath, outputPath, concatListPath];

  try {
    const hookPublicId = 'hooks/' + hook.replace(/\.[^/.]+$/, '');
    const capturePublicId = 'screenrecordings/' + capture.replace(/\.[^/.]+$/, '');

    const hookUrl = cloudinary.url(hookPublicId, { resource_type: 'video', secure: true });
    const captureUrl = cloudinary.url(capturePublicId, { resource_type: 'video', secure: true });

    console.log("Téléchargement des fichiers...");
    await Promise.all([
      downloadFile(hookUrl, hookPath),
      downloadFile(captureUrl, capturePath),
    ]);
    console.log("Fichiers téléchargés");

    const [hookProbe, captureProbe] = await Promise.all([
      probeVideo(hookPath),
      probeVideo(capturePath),
    ]);

    const hookVideo = hookProbe.streams.find(s => s.codec_type === "video");
    const captureVideo = captureProbe.streams.find(s => s.codec_type === "video");

    const canFastConcat = hookVideo && captureVideo &&
      hookVideo.codec_name === "h264" && captureVideo.codec_name === "h264" &&
      hookVideo.width === 1080 && hookVideo.height === 1920 &&
      captureVideo.width === 1080 && captureVideo.height === 1920;

    if (canFastConcat) {
      console.log("Fast concat (pas de ré-encodage)");
      fs.writeFileSync(concatListPath, `file '${hookPath}'\nfile '${capturePath}'\n`);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputOptions(["-f", "concat", "-safe", "0"])
          .outputOptions(["-c", "copy", "-movflags", "+faststart"])
          .output(outputPath)
          .on("start", (cmd) => console.log("FFmpeg:", cmd))
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    } else {
      console.log("Re-encodage...");
      const filterComplex = [
        "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]",
        "[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v1]",
        "[v0][v1]concat=n=2:v=1:a=0[outv]"
      ];

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(hookPath)
          .input(capturePath)
          .complexFilter(filterComplex)
          .outputOptions([
            "-map", "[outv]",
            "-c:v", "libx264", "-preset", "ultrafast",
            "-crf", "23", "-movflags", "+faststart",
            "-threads", "0", "-an"
          ])
          .output(outputPath)
          .on("start", (cmd) => console.log("FFmpeg:", cmd))
          .on("end", resolve)
          .on("error", reject)
          .run();
      });
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error("Le fichier de sortie n'a pas été créé.");
    }

    console.log("Upload vers Cloudinary...");
    const uploadResult = await cloudinary.uploader.upload(outputPath, {
      folder: 'montages',
      resource_type: 'video',
      public_id: `final-${timestamp}`,
    });

    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    console.log("Terminé!");
    res.status(200).json({
      message: "Vidéo générée !",
      url: uploadResult.secure_url,
    });

  } catch (error) {
    console.error("Error:", error);
    tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    res.status(400).json({ error: error.message });
  }
}
