import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import formidable from "formidable";
import fs from "fs";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  try {
    const form = formidable({ maxFileSize: 100 * 1024 * 1024 });

    const [fields, files] = await form.parse(req);

    const type = fields.type?.[0];
    const file = files.file?.[0];

    if (!file || !type) {
      return res.status(400).json({ error: 'Fichier ou type manquant.' });
    }

    if (!['hook', 'capture'].includes(type)) {
      return res.status(400).json({ error: 'Type invalide.' });
    }

    const buffer = fs.readFileSync(file.filepath);
    const folder = type === 'hook' ? 'hooks' : 'captures';
    const filename = file.originalFilename || 'video.mp4';
    const key = `${folder}/${filename}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: file.mimetype || 'video/mp4',
    }));

    fs.unlinkSync(file.filepath);

    const publicBaseUrl = "https://pub-f14155236ed54ea8847eb4db5d3c64c1.r2.dev";

    res.status(200).json({
      message: 'Upload réussi',
      url: `${publicBaseUrl}/${key}`,
      filename,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
}
