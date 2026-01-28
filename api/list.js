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

export default async function handler(req, res) {
  try {
    const [hooksResponse, capturesResponse] = await Promise.all([
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "hooks/",
      })),
      s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        Prefix: "captures/",
      })),
    ]);

    const hooks = (hooksResponse.Contents || [])
      .filter(item => item.Key !== "hooks/")
      .map(item => ({
        name: item.Key.replace("hooks/", ""),
        url: `${publicBaseUrl}/${item.Key}`,
        size: item.Size,
      }));

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
    res.status(500).json({ error: `Erreur lors du chargement des fichiers : ${error.message}` });
  }
}
