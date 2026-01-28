import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  try {
    const { filename, type } = req.body;

    if (!filename || !type) {
      return res.status(400).json({ error: 'Paramètres manquants.' });
    }

    if (!['hook', 'capture'].includes(type)) {
      return res.status(400).json({ error: 'Type invalide.' });
    }

    const folder = type === 'hook' ? 'hooks' : 'captures';
    const key = `${folder}/${filename}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    const publicBaseUrl = "https://pub-f14155236ed54ea8847eb4db5d3c64c1.r2.dev";

    res.status(200).json({
      uploadUrl,
      publicUrl: `${publicBaseUrl}/${key}`,
      filename,
    });
  } catch (error) {
    console.error('Get upload URL error:', error);
    res.status(500).json({ error: error.message });
  }
}
