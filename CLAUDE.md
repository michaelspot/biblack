# Instructions pour Claude

## Langue
- Répondre en français

## Code
- Ne jamais créer de fichiers de documentation sauf si explicitement demandé
- Garder les solutions simples et minimalistes
- Éviter le sur-engineering
- Pousser systématiquement sur le dépôt GitHub
- Pousser systématiquement après chaque fin de modification sur Vercel

## UI/UX
- Les containers de preview vidéo doivent avoir une hauteur fixe (aspect-ratio 9/16) pour éviter les layout shifts
- Tous les types de fichiers doivent être acceptés pour l'upload

## API
- Cloudflare R2 est utilisé pour le stockage
- Les endpoints disponibles : /api/list, /api/upload, /api/merge, /api/delete, /api/proxy
