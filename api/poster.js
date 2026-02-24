import cloudinary from './_cloudinary.js';

export default async function handler(req, res) {
  const { publicId } = req.query;

  if (!publicId) return res.status(400).json({ error: "Paramètre manquant : publicId" });

  const posterUrl = cloudinary.url(publicId, {
    resource_type: 'video',
    format: 'jpg',
    transformation: [{ width: 320, crop: 'scale' }],
    secure: true,
  });

  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return res.redirect(302, posterUrl);
}

export const config = {
  maxDuration: 10,
};
