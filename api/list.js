import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const publicBaseUrl = "https://pub-f14155236ed54ea8847eb4db5d3c64c1.r2.dev";

const hookCategories = [
  { id: "snapchat", prefix: "hooks-snapchat/" },
  { id: "surprised", prefix: "hooks-surprised-face/" },
  { id: "shocked", prefix: "hooks-shocked-face/" },
  { id: "dynamic", prefix: "hooks-dynamic/" },
];

export default async function handler(req, res) {
  try {
    // Liste les hooks de chaque catégorie en parallèle
    const hookPromises = hookCategories.map(async (cat) => {
      const response = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: cat.prefix,
      }));
      return {
        category: cat.id,
        items: (response.Contents || [])
          .filter(item => item.Key !== cat.prefix)
          .map(item => ({
            name: item.Key.replace(cat.prefix, ""),
            url: `${publicBaseUrl}/${item.Key}`,
            size: item.Size,
            category: cat.id,
            prefix: cat.prefix,
          })),
      };
    });

    // Liste les captures
    const capturesResponse = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: "captures/",
    }));

    const hookResults = await Promise.all(hookPromises);

    // Combine tous les hooks avec leur catégorie
    const hooks = hookResults.flatMap(r => r.items);

    const captures = (capturesResponse.Contents || [])
      .filter(item => item.Key !== "captures/")
      .map(item => ({
        name: item.Key.replace("captures/", ""),
        url: `${publicBaseUrl}/${item.Key}`,
        size: item.Size,
      }));

    res.status(200).json({ hooks, captures });
  } catch (error) {
    console.error("List error:", error);
    res.status(500).json({ error: error.message });
  }
}
