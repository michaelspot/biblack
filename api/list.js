import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const publicBaseUrl = "https://pub-f14155236ed54ea8847eb4db5d3c64c1.r2.dev";

export default async function handler(req, res) {
  try {
    const [hooksResponse, capturesResponse, hookPostersResponse, capturePostersResponse, musiquesResponse, textesResponse] = await Promise.all([
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "hooks/",
      })),
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "captures/",
      })),
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "posters/hooks/",
      })),
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "posters/captures/",
      })),
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "musiques/",
      })),
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "textes/",
      })),
    ]);

    const hookPosterSet = new Set(
      (hookPostersResponse.Contents || []).map(i => i.Key.replace("posters/hooks/", "").replace(".jpg", ""))
    );
    const capturePosterSet = new Set(
      (capturePostersResponse.Contents || []).map(i => i.Key.replace("posters/captures/", "").replace(".jpg", ""))
    );

    const hooks = (hooksResponse.Contents || [])
      .filter(item => item.Key !== "hooks/")
      .map(item => {
        const name = item.Key.replace("hooks/", "");
        return {
          name,
          url: `${publicBaseUrl}/${item.Key}`,
          posterUrl: hookPosterSet.has(name) ? `${publicBaseUrl}/posters/hooks/${name}.jpg` : null,
          size: item.Size,
          lastModified: item.LastModified,
        };
      })
      .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    const captures = (capturesResponse.Contents || [])
      .filter(item => item.Key !== "captures/")
      .map(item => {
        const name = item.Key.replace("captures/", "");
        return {
          name,
          url: `${publicBaseUrl}/${item.Key}`,
          posterUrl: capturePosterSet.has(name) ? `${publicBaseUrl}/posters/captures/${name}.jpg` : null,
          size: item.Size,
          lastModified: item.LastModified,
        };
      })
      .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    const musiques = (musiquesResponse.Contents || [])
      .filter(item => item.Key !== "musiques/")
      .map(item => ({
        name: item.Key.replace("musiques/", ""),
        url: `${publicBaseUrl}/${item.Key}`,
        size: item.Size,
        lastModified: item.LastModified,
      }))
      .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

    let textes = [];
    const textesFiles = (textesResponse.Contents || []).filter(item => item.Key !== "textes/" && item.Key.endsWith('.json'));
    if (textesFiles.length > 0) {
      const textObj = await s3.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: textesFiles[0].Key,
      }));
      const body = await textObj.Body.transformToString();
      textes = JSON.parse(body);
    }

    res.status(200).json({ hooks, captures, musiques, textes });
  } catch (error) {
    console.error("List error:", error);
    res.status(500).json({ error: `Erreur lors du chargement des fichiers : ${error.message}` });
  }
}
