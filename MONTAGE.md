# Architecture du montage vidéo

## Pipeline de génération (Bulk)

Endpoint : `/api/bulk-merge`

### Étapes FFmpeg

1. **Scale + Pad** : Chaque vidéo (hook et capture) est redimensionnée en 1080x1920 (format TikTok 9:16) en gardant le ratio d'aspect, avec du padding noir si nécessaire.
2. **Concat** : Le hook est concaténé avant la capture (hook joue en premier, puis la capture).
3. **Text overlay** : Un PNG transparent 1080x1920 est généré via `sharp` et composité sur la vidéo avec le filtre `overlay`.
4. **Audio** : Si une musique est sélectionnée, elle est ajoutée comme piste audio (`-shortest` pour couper à la durée de la vidéo).

### Overlay texte (sharp + SVG)

Le filtre `drawtext` de FFmpeg n'est pas disponible dans le binaire `ffmpeg-static` sur Vercel. On utilise donc `sharp` pour générer un PNG transparent :

```
SVG (1080x1920) → sharp → PNG transparent → FFmpeg overlay filter
```

#### Positionnement actuel
- **Taille canvas** : 1080x1920 (plein écran TikTok)
- **Position** : Centré horizontalement (`text-anchor="middle"`, `x=540`) et verticalement (`y ≈ 960`, ajusté selon le nombre de lignes)
- **Font** : `sans-serif`, `font-weight: 700` (bold)
- **Taille** : `font-size: 60px`
- **Couleur** : Blanc (`fill="white"`)
- **Bordure** : Noir, épaisseur 4px (`stroke="black"`, `stroke-width="4"`, `paint-order="stroke"` pour que le stroke soit derrière le fill)
- **Line height** : 72px entre chaque ligne
- **Word wrap** : Automatique à 25 caractères max par ligne

#### Calcul du positionnement vertical
```
startY = 960 - (totalHeight / 2) + 50
```
- `960` = milieu vertical du canvas 1920px
- `totalHeight` = nombre de lignes × 72px
- `+50` = ajustement pour la baseline du texte

#### SVG généré (exemple)
```xml
<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <text text-anchor="middle" font-size="60" font-weight="700"
    font-family="sans-serif" fill="white" stroke="black"
    stroke-width="4" paint-order="stroke">
    <tspan x="540" y="924">Première ligne du</tspan>
    <tspan x="540" y="996">texte ici</tspan>
  </text>
</svg>
```

## Pipeline de génération (Montage simple)

Endpoint : `/api/merge`

### Fast path
Si les deux vidéos sont déjà en H.264 1080x1920 : concat sans ré-encodage (`-c copy`). Très rapide (~2s).

### Slow path
Sinon : scale + pad + concat avec ré-encodage (`libx264 ultrafast`). Plus lent (~15-30s).

Pas de musique ni de texte dans le montage simple.

## Sélection Bulk (frontend)

- L'utilisateur sélectionne des hooks, captures, musiques et textes
- Un prompt demande combien de vidéos générer (max = hooks × captures)
- Les combinaisons hook+capture sont mélangées aléatoirement (Fisher-Yates)
- Pour chaque combinaison, une musique et un texte sont choisis aléatoirement parmi la sélection
- Les vidéos sont générées séquentiellement puis bundlées dans un ZIP
