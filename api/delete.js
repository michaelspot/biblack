import cloudinary from './_cloudinary.js';

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

    const folder = type === 'hook' ? 'hooks' : 'screenrecordings';
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    const publicId = `${folder}/${nameWithoutExt}`;

    await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });

    res.status(200).json({
      message: 'Fichier supprimé',
      filename,
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
}
