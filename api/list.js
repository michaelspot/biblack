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

async function listResources(folder, resourceType) {
  try {
    const result = await cloudinary.api.resources({
      type: 'upload',
      resource_type: resourceType,
      asset_folder: folder,
      max_results: 500,
    });
    return result.resources || [];
  } catch (e) {
    console.log(`No ${resourceType} resources found for folder "${folder}":`, e.message);
    return [];
  }
}

export default async function handler(req, res) {
  try {
    // Lancer toutes les requêtes en parallèle
    // Musiques peuvent être video ou raw selon comment elles ont été uploadées
    // Textes peuvent être raw ou image selon Cloudinary
    const [
      hooksVideo,
      capturesVideo,
      musicsVideo,
      musicsRaw,
      textsRaw,
      textsImage,
    ] = await Promise.all([
      listResources('hooks', 'video'),
      listResources('screenrecordings', 'video'),
      listResources('musics', 'video'),
      listResources('musics', 'raw'),
      listResources('texts', 'raw'),
      listResources('texts', 'image'),
    ]);

    const hooks = hooksVideo.map(r => ({
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
    })).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    const captures = capturesVideo.map(r => ({
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
    })).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    // Combiner musiques video + raw
    const allMusics = [...musicsVideo, ...musicsRaw];
    const musiques = allMusics.map(r => ({
      name: (r.display_name || r.public_id.replace(/^.*\//, '')) + '.' + r.format,
      url: r.secure_url,
      size: r.bytes,
      lastModified: r.created_at,
      public_id: r.public_id,
      resource_type: r.resource_type,
    })).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    // Combiner textes raw + image
    let textes = [];
    const allTexts = [...textsRaw, ...textsImage];
    const textFiles = allTexts.filter(r =>
      r.public_id.includes('.json') || r.format === 'json'
    );
    if (textFiles.length > 0) {
      textes = await fetchJson(textFiles[0].secure_url);
    }

    console.log(`List: ${hooks.length} hooks, ${captures.length} captures, ${musiques.length} musiques, ${textes.length} textes`);
    console.log('All resources:', { hooksVideo: hooksVideo.length, capturesVideo: capturesVideo.length, musicsVideo: musicsVideo.length, musicsRaw: musicsRaw.length, textsRaw: textsRaw.length, textsImage: textsImage.length });
    if (hooksVideo.length > 0) console.log('Hook sample:', hooksVideo[0].public_id, hooksVideo[0].asset_folder);
    if (capturesVideo.length > 0) console.log('Capture sample:', capturesVideo[0].public_id, capturesVideo[0].asset_folder);

    res.status(200).json({ hooks, captures, musiques, textes });
  } catch (error) {
    console.error("List error:", error);
    res.status(500).json({ error: `Erreur lors du chargement des fichiers : ${error.message}` });
  }
}
