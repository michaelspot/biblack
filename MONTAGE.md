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
Font TikTok Sans Medium (base64 JS module) → GlobalFonts.register() → Canvas 2D → PNG → FFmpeg overlay filter
```

**Pourquoi @napi-rs/canvas :** sharp+SVG ne gère pas bien les fonts embarquées (carrés à la place du texte). `@napi-rs/canvas` utilise un vrai moteur de rendu texte avec `registerFont()`, `strokeText()` et `fillText()`.

**Pourquoi embarquer la font :** Les polices système ne sont pas disponibles sur Vercel serverless. La font TikTok Sans Medium est stockée en base64 dans `api/font-tiktok.js` et enregistrée via `GlobalFonts.register()` au démarrage du module.

**Emojis :** Les emojis sont automatiquement retirés du texte avant le rendu (la font ne les supporte pas). Regex : `[\p{Emoji_Presentation}\p{Extended_Pictographic}]`.

#### Style actuel (TikTok)
- **Font** : TikTok Sans Medium 500 (base64 dans `api/font-tiktok.js`, enregistrée via `GlobalFonts.register()`)
- **Taille** : `38px`
- **Couleur fill** : `white`
- **Stroke** : `black`, `lineWidth: 8`, `lineJoin: round`
- **Rendu** : `strokeText()` d'abord (bordure derrière), puis `fillText()` (blanc devant)
- **textAlign** : `center`
- **textBaseline** : `middle`
- **Line height** : 48px entre chaque ligne
- **Word wrap** : Basé sur `ctx.measureText()`, largeur max 864px (80% du canvas), max 3 lignes. Retour à la ligne forcé après "et" et sur double espace.
- **Canvas** : 1080x1920 (plein écran TikTok)

#### Safe zone TikTok
- **0% → 7%** : non-safe (status bar + Following/For You)
- **7% → 45%** : safe, de 5% à 95% horizontal (photo profil en haut à droite)
- **45% → 60%** : safe réduite, de 5% à 85% horizontal (icônes coeur/commentaire/bookmark/share à droite)
- **60% → 100%** : non-safe (caption, CTA, navigation)
- **Largeur max texte** : 864px (80% du canvas)

#### Positionnement
- **Horizontal** : Centré à `x = 540`
- **Vertical** : Contrôlé par un slider (paramètre `textY`, 0-100). Formule :
```
availableRange = safeBottom - safeTop - totalHeight
startY = safeTop + (availableRange * textY / 100) + lineHeight / 2
```
- `textY = 0` → texte en haut de la safe zone (134px, 7%)
- `textY = 100` → texte en bas de la safe zone (1152px, 60%)
- `textY = 50` → centré dans la safe zone

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
