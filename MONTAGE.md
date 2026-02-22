# Architecture du montage vidéo

## Pipeline de génération (Bulk)

Endpoint : `/api/bulk-merge`

### Étapes FFmpeg

1. **Scale + Pad** : Chaque vidéo (hook et capture) est redimensionnée en 1080x1920 (format TikTok 9:16) en gardant le ratio d'aspect, avec du padding noir si nécessaire.
2. **Concat** : Le hook est concaténé avant la capture (hook joue en premier, puis la capture).
3. **Text overlay** : Un PNG transparent 1080x1920 est généré via `sharp` et composité sur la vidéo avec le filtre `overlay`.
4. **Audio** : Si une musique est sélectionnée, elle est ajoutée comme piste audio (`-shortest` pour couper à la durée de la vidéo).

### Overlay texte (@napi-rs/canvas + font embarquée)

Le filtre `drawtext` de FFmpeg n'est pas disponible dans le binaire `ffmpeg-static` sur Vercel. On utilise `@napi-rs/canvas` pour générer un PNG transparent :

```
Font Anton (base64 JS module) → GlobalFonts.register() → Canvas 2D → PNG → FFmpeg overlay filter
```

**Pourquoi @napi-rs/canvas :** sharp+SVG ne gère pas bien les fonts embarquées (carrés à la place du texte). `@napi-rs/canvas` utilise un vrai moteur de rendu texte avec `registerFont()`, `strokeText()` et `fillText()`.

**Pourquoi embarquer la font :** Les polices système ne sont pas disponibles sur Vercel serverless. La font Anton est stockée en base64 dans `api/font-anton.js` et enregistrée via `GlobalFonts.register()` au démarrage du module.

**Emojis :** Les emojis sont automatiquement retirés du texte avant le rendu (la font Anton ne les supporte pas). Regex : `[\p{Emoji_Presentation}\p{Extended_Pictographic}]`.

#### Style actuel (TikTok-like)
- **Font** : Anton (Google Fonts, base64 dans `api/font-anton.js`, enregistrée via `GlobalFonts.register()`)
- **Taille** : `75px`
- **Couleur fill** : `white`
- **Stroke** : `black`, `lineWidth: 8`, `lineJoin: round`
- **Rendu** : `strokeText()` d'abord (bordure derrière), puis `fillText()` (blanc devant)
- **textAlign** : `center`
- **textBaseline** : `middle`
- **Line height** : 90px entre chaque ligne
- **Word wrap** : Automatique à 20 caractères max par ligne
- **Canvas** : 1080x1920 (plein écran TikTok)

#### Positionnement
- **Horizontal** : Centré (`textAlign = 'center'`, `x = 540`)
- **Vertical** : Centré sur l'écran, formule :
```
startY = 960 - (totalHeight / 2) + lineHeight / 2
```
- `960` = milieu vertical du canvas 1920px
- `totalHeight` = nombre de lignes × 90px
- `+ lineHeight / 2` = ajustement car `textBaseline = 'middle'`

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
