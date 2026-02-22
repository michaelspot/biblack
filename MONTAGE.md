# Architecture du montage vidéo

## Pipeline de génération (Bulk)

Endpoint : `/api/bulk-merge`

### Étapes FFmpeg

1. **Scale + Pad** : Chaque vidéo (hook et capture) est redimensionnée en 1080x1920 (format TikTok 9:16) en gardant le ratio d'aspect, avec du padding noir si nécessaire.
2. **Concat** : Le hook est concaténé avant la capture (hook joue en premier, puis la capture).
3. **Text overlay** : Un PNG transparent 1080x1920 est généré via `sharp` et composité sur la vidéo avec le filtre `overlay`.
4. **Audio** : Si une musique est sélectionnée, elle est ajoutée comme piste audio (`-shortest` pour couper à la durée de la vidéo).

### Overlay texte (sharp + SVG + font embarquée)

Le filtre `drawtext` de FFmpeg n'est pas disponible dans le binaire `ffmpeg-static` sur Vercel. On utilise donc `sharp` pour générer un PNG transparent :

```
Font Anton (base64) → SVG (1080x1920) → sharp → PNG transparent → FFmpeg overlay filter
```

**Pourquoi embarquer la font :** Les polices système ne sont pas disponibles sur Vercel serverless. La font Anton est lue depuis `fonts/Anton-Regular.ttf`, convertie en base64, et injectée dans le SVG via `@font-face` data URI. Le résultat est caché en mémoire après le premier appel.

#### Style actuel (TikTok-like)
- **Font** : Anton (Google Fonts, embarquée en base64 dans le SVG via `@font-face`)
- **Fallbacks** : `Impact, sans-serif`
- **Taille** : `font-size: 75px`
- **Poids** : `font-weight: 900` (extra bold)
- **Couleur** : Blanc (`fill="white"`)
- **Bordure** : Noir, épaisseur 7px (`stroke="black"`, `stroke-width="7"`)
- **paint-order** : `stroke` (le stroke est dessiné derrière le fill)
- **stroke-linejoin** : `round` (coins arrondis sur le contour, rendu plus propre)
- **Line height** : 90px entre chaque ligne
- **Word wrap** : Automatique à 20 caractères max par ligne
- **Canvas** : 1080x1920 (plein écran TikTok)

#### Positionnement
- **Horizontal** : Centré (`text-anchor="middle"`, `x=540`)
- **Vertical** : Centré sur l'écran, formule :
```
startY = 960 - (totalHeight / 2) + 55
```
- `960` = milieu vertical du canvas 1920px
- `totalHeight` = nombre de lignes × 90px
- `+55` = ajustement pour la baseline du texte

#### SVG généré (exemple)
```xml
<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: 'Anton';
        src: url('data:font/truetype;base64,...');
      }
    </style>
  </defs>
  <text text-anchor="middle" font-size="75" font-weight="900"
    font-family="Anton, Impact, sans-serif" fill="white"
    stroke="black" stroke-width="7" paint-order="stroke"
    stroke-linejoin="round">
    <tspan x="540" y="915">Donc PERSONNE m'a</tspan>
    <tspan x="540" y="1005">dit qu'on pouvait</tspan>
    <tspan x="540" y="1095">étudier la BIBLE 😳</tspan>
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
