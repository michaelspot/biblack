import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { scrapProgress, SCRAP_LABELS, type ScrapJob } from '../scrap';
import { colors, radii, spacing } from '../theme';

export function ScrapProgress({ job, active, connectionError, onStop }: {
  job: ScrapJob; active: boolean; connectionError: string | null; onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now() / 1000);
    const timer = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const { percent, elapsed, estimate } = scrapProgress(job, now);
  const stopping = job.status === 'cancelling';
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text accessibilityLiveRegion="polite" style={styles.stage}>{SCRAP_LABELS[job.status]}</Text>
        <Text style={styles.percent}>{percent} %</Text>
      </View>
      <View accessible accessibilityRole="progressbar" accessibilityLabel="Progression du traitement"
        accessibilityValue={{ min: 0, max: 100, now: percent }} style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
      <View style={styles.timing}>
        <Text style={styles.remaining}>{connectionError ? 'Suivi interrompu…' : estimate}</Text>
        <Text style={styles.elapsed}>{elapsed} écoulées</Text>
      </View>
      {connectionError ? <Text accessibilityRole="alert" style={styles.error}>{connectionError}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Arrêter le traitement"
        accessibilityState={{ disabled: stopping, busy: stopping }} disabled={stopping} onPress={onStop}
        style={({ pressed }) => [styles.stop, pressed && styles.pressed, stopping && styles.disabled]}>
        {stopping ? <ActivityIndicator size="small" color={colors.danger} /> : <Ionicons name="stop" size={17} color={colors.danger} />}
        <Text style={styles.stopText}>{stopping ? 'Arrêt en cours…' : 'Arrêter'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.lg, gap: spacing.md, borderRadius: radii.lg, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stage: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  percent: { color: colors.accent, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.border },
  fill: { height: '100%', borderRadius: 4, backgroundColor: colors.accent },
  timing: { gap: spacing.xs },
  remaining: { color: colors.text, fontSize: 13, lineHeight: 19 },
  elapsed: { color: colors.textMuted, fontSize: 12, fontVariant: ['tabular-nums'] },
  error: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  stop: { minHeight: 48, borderRadius: radii.md, borderWidth: 1, borderColor: colors.danger, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.xs },
  stopText: { color: colors.danger, fontSize: 14, fontWeight: '700' },
  pressed: { backgroundColor: colors.dangerSoft },
  disabled: { opacity: .65 },
});
