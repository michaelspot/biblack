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

async function searchFolder(folder) {
  try {
    const result = await cloudinary.search
      .expression(`asset_folder="${folder}"`)
      .with_field('tags')
      .sort_by('created_at', 'desc')
      .max_results(500)
      .execute();
    return result.resources || [];
  } catch (e) {
    console.log(`Search error for folder "${folder}":`, e.message);
    return [];
  }
}

export default async function handler(req, res) {
  try {
    // Search API : 1 requête par dossier, filtrage resource_type côté code
    const [hooksAll, capturesAll, musicsAll, textsAll] = await Promise.all([
      searchFolder('hooks'),
      searchFolder('screenrecordings'),
      searchFolder('musics'),
      searchFolder('texts'),
    ]);

    console.log(`Search results: hooks=${hooksAll.length}, screenrecordings=${capturesAll.length}, musics=${musicsAll.length}, texts=${textsAll.length}`);
    if (hooksAll.length > 0) console.log('Hook sample:', hooksAll[0].public_id, hooksAll[0].asset_folder, hooksAll[0].resource_type);
    if (capturesAll.length > 0) console.log('Capture sample:', capturesAll[0].public_id, capturesAll[0].asset_folder, capturesAll[0].resource_type);
    if (musicsAll.length > 0) console.log('Music sample:', musicsAll[0].public_id, musicsAll[0].asset_folder, musicsAll[0].resource_type);
    if (textsAll.length > 0) console.log('Text sample:', textsAll[0].public_id, textsAll[0].asset_folder, textsAll[0].resource_type);

    const hooks = hooksAll
      .filter(r => r.resource_type === 'video')
      .map(r => ({
        name: (r.display_name || r.public_id.replace(/^.*\//, '')) + '.' + r.format,
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
        tags: r.tags || [],
      }));

    const captures = capturesAll
      .filter(r => r.resource_type === 'video')
      .map(r => ({
        name: (r.display_name || r.public_id.replace(/^.*\//, '')) + '.' + r.format,
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
        tags: r.tags || [],
      }));

    const musiques = musicsAll.map(r => ({
      name: (r.display_name || r.public_id.replace(/^.*\//, '')) + '.' + r.format,
      url: r.secure_url,
      size: r.bytes,
      lastModified: r.created_at,
      public_id: r.public_id,
      resource_type: r.resource_type,
      tags: r.tags || [],
    }));

    // Textes : chercher le fichier JSON
    let textes = [];
    const textFiles = textsAll.filter(r =>
      r.public_id.includes('.json') || r.format === 'json'
    );
    if (textFiles.length > 0) {
      const rawTextes = await fetchJson(textFiles[0].secure_url);
      textes = rawTextes.map(t => {
        if (typeof t === 'string') return { text: t, tags: [] };
        return { text: t.text || t, tags: t.tag ? [t.tag] : [] };
      });
    }

    console.log(`Final: ${hooks.length} hooks, ${captures.length} captures, ${musiques.length} musiques, ${textes.length} textes`);

    res.status(200).json({ hooks, captures, musiques, textes });
  } catch (error) {
    console.error("List error:", error);
    res.status(500).json({ error: `Erreur lors du chargement des fichiers : ${error.message}` });
  }
}
