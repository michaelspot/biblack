import cloudinary from './_cloudinary.js';
import https from 'https';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve([]); }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  try {
    const { text, tag } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Texte manquant.' });
    }

    // Récupérer le JSON existant
    let textes = [];
    try {
      const result = await cloudinary.search
        .expression('asset_folder="texts"')
        .sort_by('created_at', 'desc')
        .max_results(10)
        .execute();

      const jsonFile = (result.resources || []).find(r =>
        r.public_id.includes('.json') || r.format === 'json'
      );

      if (jsonFile) {
        textes = await fetchJson(jsonFile.secure_url);
      }
    } catch (e) {
      console.log('No existing texts file, creating new one');
    }

    // Ajouter le nouveau texte
    const newEntry = { text: text.trim() };
    if (tag && tag.trim()) {
      newEntry.tag = tag.trim();
    }
    textes.push(newEntry);

    // Upload le JSON mis à jour
    const jsonStr = JSON.stringify(textes, null, 2);
    const dataUri = `data:application/json;base64,${Buffer.from(jsonStr).toString('base64')}`;

    await cloudinary.uploader.upload(dataUri, {
      folder: 'texts',
      resource_type: 'raw',
      public_id: 'textes.json',
      overwrite: true,
    });

    res.status(200).json({ message: 'Texte ajouté', count: textes.length });
  } catch (error) {
    console.error('Add text error:', error);
    res.status(500).json({ error: error.message });
  }
}
