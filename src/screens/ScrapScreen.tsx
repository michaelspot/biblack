import { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { PrimaryButton } from '../components/Button';
import { ResultCard } from '../components/ResultCard';
import { ScrapProgress } from '../components/ScrapProgress';
import { useScrapJob } from '../hooks/useScrapJob';
import { normalizeScrapUrl } from '../scrap';
import { colors, radii, spacing } from '../theme';
import { errorMessage } from '../utils';

interface ScrapScreenProps {
  active: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}

export function ScrapScreen({ active, disabled, onBusyChange }: ScrapScreenProps) {
  const [url, setUrl] = useState('');
  const [removeText, setRemoveText] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const { job, sourceUrl, ready, pending, connectionError, start, stop } = useScrapJob(active);
  const locked = disabled || pending || !ready;

  useEffect(() => { if (sourceUrl) setUrl(sourceUrl); }, [sourceUrl]);
  const jobRemoveText = job?.removeText;
  useEffect(() => { if (jobRemoveText !== undefined) setRemoveText(jobRemoveText); }, [jobRemoveText]);

  const launch = () => {
    if (locked) return;
    try {
      const normalized = normalizeScrapUrl(url);
      start(normalized, removeText);
      setUrl(normalized);
      setInputError(null);
      Keyboard.dismiss();
    } catch (error) { setInputError(errorMessage(error)); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.heading}>
          <View style={styles.eyebrow}><Ionicons name="link" size={15} color={colors.accent} /><Text style={styles.eyebrowText}>TIKTOK & INSTAGRAM</Text></View>
          <Text style={styles.title}>Scrap</Text>
          <Text style={styles.subtitle}>Un lien. Ta vidéo, prête à garder.</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Lien de la vidéo</Text>
          <TextInput
            accessibilityLabel="Lien TikTok ou Instagram"
            autoCapitalize="none" autoCorrect={false} editable={!locked} keyboardType="url"
            maxLength={2048} onChangeText={value => { setUrl(value); setInputError(null); }}
            onSubmitEditing={launch} placeholder="Colle ton lien ici…" placeholderTextColor={colors.textFaint}
            returnKeyType="go" selectionColor={colors.accent} style={[styles.input, locked && styles.disabled]} value={url}
          />
          <Pressable
            accessibilityRole="checkbox" accessibilityState={{ checked: removeText, disabled: locked }}
            disabled={locked} onPress={() => setRemoveText(value => !value)}
            style={({ pressed }) => [styles.option, pressed && styles.pressed, locked && styles.disabled]}
          >
            <View style={[styles.checkbox, removeText && styles.checked]}>
              {removeText ? <Ionicons name="checkmark" size={18} color={colors.accentInk} /> : null}
            </View>
            <View style={styles.optionCopy}>
              <Text style={styles.optionTitle}>Supprimer le texte</Text>
              <Text style={styles.help}>{removeText ? 'Le texte détecté dans l’image sera effacé automatiquement.' : 'La vidéo sera téléchargée en conservant son texte.'}</Text>
            </View>
          </Pressable>
          {inputError ? <Text accessibilityRole="alert" style={styles.error}>{inputError}</Text> : null}
          <PrimaryButton disabled={locked || !url.trim()} icon={removeText ? 'sparkles-outline' : 'download-outline'} label={pending ? 'Traitement en cours…' : 'Lancer'} onPress={launch} />
        </View>

        {pending && job ? (
          <ScrapProgress job={job} active={active} connectionError={connectionError} onStop={stop} />
        ) : null}
        {job?.status === 'cancelled' ? (
          <View accessibilityLiveRegion="polite" style={styles.cancelled}>
            <Ionicons name="stop-circle-outline" size={22} color={colors.textMuted} />
            <View style={styles.optionCopy}>
              <Text style={styles.optionTitle}>Traitement arrêté</Text>
              <Text style={styles.help}>Tu peux lancer une autre vidéo.</Text>
            </View>
          </View>
        ) : null}
        {job?.status === 'failed' ? (
          <View accessibilityRole="alert" style={styles.failure}>
            <Text style={styles.optionTitle}>Impossible de récupérer la vidéo</Text>
            <Text style={styles.error}>{job.error || 'Réessaie avec le lien d’une vidéo publique.'}</Text>
          </View>
        ) : null}
        {job?.status === 'completed' && job.url && job.name ? (
          <View style={styles.result}>
            <Text style={styles.help}>{job.note || (job.removeText ? 'Texte supprimé · son conservé' : 'Vidéo téléchargée · texte conservé')}</Text>
            <ResultCard active={active} onBusyChange={onBusyChange} result={{ url: job.url, name: job.name }} />
            <Text style={styles.expiry}>Disponible pendant 24 h. Enregistre-la dans Photos pour la garder.</Text>
          </View>
        ) : null}
        {!job ? <Text style={styles.expiry}>Vidéos publiques · jusqu’à 3 min avec suppression du texte, 10 min sans.</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, paddingTop: spacing.xxl, gap: spacing.xl, paddingBottom: spacing.xxl },
  heading: { gap: spacing.sm },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eyebrowText: { color: colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.8 },
  title: { color: colors.text, fontSize: 38, fontWeight: '800', letterSpacing: -1.8 },
  subtitle: { color: colors.textMuted, fontSize: 15, lineHeight: 21 },
  form: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.lg },
  label: { color: colors.text, fontSize: 13, fontWeight: '700' },
  input: { color: colors.text, fontSize: 15, minHeight: 56, paddingHorizontal: spacing.md, backgroundColor: colors.background, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderStrong },
  option: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64 },
  checkbox: { width: 26, height: 26, borderWidth: 1.5, borderColor: colors.textFaint, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.accent, borderColor: colors.accent },
  optionCopy: { flex: 1, gap: 5 },
  optionTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  help: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  cancelled: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface },
  failure: { padding: spacing.lg, gap: spacing.sm, borderRadius: radii.md, backgroundColor: colors.dangerSoft },
  result: { gap: spacing.md },
  expiry: { color: colors.textFaint, fontSize: 11, lineHeight: 17, textAlign: 'center', paddingHorizontal: spacing.md },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
});
