import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
    bodyParser: {
      sizeLimit: '100mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée. Utilisez POST.' });
  }

  try {
    const { filename, type, data } = req.body;

    if (!filename || !type || !data) {
      return res.status(400).json({ error: 'Données manquantes : nom de fichier, type ou contenu requis.' });
    }

    if (!['hook', 'capture'].includes(type)) {
      return res.status(400).json({ error: 'Type invalide. Utilisez "hook" ou "capture".' });
    }

    // Decode base64
    const buffer = Buffer.from(data, 'base64');
    const folder = type === 'hook' ? 'hooks' : 'captures';
    const key = `${folder}/${filename}`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: 'video/mp4',
    }));

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
