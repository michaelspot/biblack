import cloudinary from './_cloudinary.js';
import formidable from 'formidable';

export const config = {
  api: { bodyParser: false },
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

    const folder = type === 'hook' ? 'hooks' : 'screenrecordings';
    const filename = file.originalFilename || 'video.mp4';
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

    const result = await cloudinary.uploader.upload(file.filepath, {
      folder: folder,
      resource_type: 'video',
      public_id: nameWithoutExt,
      overwrite: true,
    });

    res.status(200).json({
      message: 'Upload réussi',
      url: result.secure_url,
      filename,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
}
