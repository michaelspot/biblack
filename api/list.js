import cloudinary from './_cloudinary.js';
import https from 'https';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

export default async function handler(req, res) {
  try {
    const [hooksResult, capturesResult, musicsResult, textsResult] = await Promise.all([
      cloudinary.api.resources({
        type: 'upload',
        resource_type: 'video',
        prefix: 'hooks',
        max_results: 500,
      }),
      cloudinary.api.resources({
        type: 'upload',
        resource_type: 'video',
        prefix: 'screenrecordings',
        max_results: 500,
      }),
      cloudinary.api.resources({
        type: 'upload',
        resource_type: 'video',
        prefix: 'musics',
        max_results: 500,
      }),
      cloudinary.api.resources({
        type: 'upload',
        resource_type: 'raw',
        prefix: 'texts',
        max_results: 10,
      }),
    ]);

    const hooks = (hooksResult.resources || []).map(r => ({
      name: r.public_id.replace('hooks/', '') + '.' + r.format,
      url: r.secure_url,
      posterUrl: cloudinary.url(r.public_id, {
        resource_type: 'video',
        format: 'jpg',
        transformation: [{ width: 320, crop: 'scale' }],
        secure: true,
      }),
      size: r.bytes,
      lastModified: r.created_at,
      public_id: r.public_id,
    })).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    const captures = (capturesResult.resources || []).map(r => ({
      name: r.public_id.replace('screenrecordings/', '') + '.' + r.format,
      url: r.secure_url,
      posterUrl: cloudinary.url(r.public_id, {
        resource_type: 'video',
        format: 'jpg',
        transformation: [{ width: 320, crop: 'scale' }],
        secure: true,
      }),
      size: r.bytes,
      lastModified: r.created_at,
      public_id: r.public_id,
    })).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    const musiques = (musicsResult.resources || []).map(r => ({
      name: r.public_id.replace('musics/', '') + '.' + r.format,
      url: r.secure_url,
      size: r.bytes,
      lastModified: r.created_at,
      public_id: r.public_id,
    })).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    let textes = [];
    const textFiles = (textsResult.resources || []).filter(r =>
      r.public_id.includes('.json') || r.format === 'json'
    );
    if (textFiles.length > 0) {
      textes = await fetchJson(textFiles[0].secure_url);
    }

    res.status(200).json({ hooks, captures, musiques, textes });
  } catch (error) {
    console.error("List error:", error);
    res.status(500).json({ error: `Erreur lors du chargement des fichiers : ${error.message}` });
  }
}
