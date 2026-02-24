import cloudinary from './_cloudinary.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Méthode non autorisée. Utilisez DELETE.' });
  }

  try {
    const { publicId, resourceType } = req.query;

    if (!publicId) {
      return res.status(400).json({ error: 'Paramètre manquant : publicId requis.' });
    }

    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'video' });

    res.status(200).json({
      message: 'Fichier supprimé',
      publicId,
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
}
