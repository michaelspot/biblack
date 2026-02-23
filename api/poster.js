import cloudinary from './_cloudinary.js';

export default async function handler(req, res) {
  const { type, filename } = req.query;

  if (!type || !filename) return res.status(400).json({ error: "Paramètres manquants" });
  if (!["hook", "capture"].includes(type)) return res.status(400).json({ error: "Type invalide" });

  const folder = type === "hook" ? "hooks" : "screenrecordings";
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
  const publicId = `${folder}/${nameWithoutExt}`;

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
