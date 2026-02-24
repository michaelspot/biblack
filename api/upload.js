import cloudinary from './_cloudinary.js';
import formidable from 'formidable';

export const config = {
  api: { bodyParser: false },
};

const FOLDER_MAP = {
  hook: 'hooks',
  capture: 'screenrecordings',
  musique: 'musics',
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
    const tag = fields.tag?.[0]?.trim();

    if (!file || !type) {
      return res.status(400).json({ error: 'Fichier ou type manquant.' });
    }

    const folder = FOLDER_MAP[type];
    if (!folder) {
      return res.status(400).json({ error: 'Type invalide.' });
    }

    const filename = file.originalFilename || 'file';
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');

    const uploadOptions = {
      folder,
      resource_type: type === 'musique' ? 'auto' : 'video',
      public_id: nameWithoutExt,
      overwrite: true,
    };

    if (tag) {
      uploadOptions.tags = [tag];
    }

    const result = await cloudinary.uploader.upload(file.filepath, uploadOptions);

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
