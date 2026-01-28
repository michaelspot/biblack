import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Méthode non autorisée. Utilisez DELETE.' });
  }

  try {
    const { filename, type } = req.query;

    if (!filename || !type) {
      return res.status(400).json({ error: 'Paramètres manquants : filename et type requis.' });
    }

    if (!['hook', 'capture'].includes(type)) {
      return res.status(400).json({ error: 'Type invalide. Utilisez "hook" ou "capture".' });
    }

    const folder = type === 'hook' ? 'hooks' : 'captures';
    const key = `${folder}/${filename}`;

    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }));

    res.status(200).json({
      message: 'Fichier supprimé',
      filename,
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
}
