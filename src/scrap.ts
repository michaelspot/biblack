export type ScrapStage = 'queued' | 'downloading' | 'starting' | 'detecting' | 'cleaning' | 'exporting' | 'completed' | 'failed' | 'cancelling' | 'cancelled';

export interface ScrapJob {
  id: string;
  status: ScrapStage;
  removeText: boolean;
  progress?: number;
  overallProgress?: number;
  createdAt?: number;
  updatedAt?: number;
  etaSeconds?: number | null;
  etaUpdatedAt?: number;
  url?: string;
  name?: string;
  error?: string;
  note?: string;
  expiresAt?: number;
}

export const SCRAP_LABELS: Record<ScrapStage, string> = {
  queued: 'Préparation de la vidéo…',
  downloading: 'Téléchargement de la vidéo…',
  starting: 'Démarrage du moteur…',
  detecting: 'Détection du texte…',
  cleaning: 'Suppression du texte…',
  exporting: 'Préparation du résultat…',
  completed: 'Vidéo prête',
  failed: 'Traitement impossible',
  cancelling: 'Arrêt en cours…',
  cancelled: 'Traitement arrêté',
};

export function normalizeScrapUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Colle un lien TikTok ou Instagram valide.');
  // Accept the sentence copied by the social app, as well as a bare URL.
  const link = value.trim().match(/https:\/\/[^\s<>"“”]+/i)?.[0] ?? value.trim();
  let url: URL;
  try { url = new URL(link); } catch { throw new Error('Colle un lien TikTok ou Instagram valide.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'instagram.com', 'www.instagram.com'].includes(host)) {
    throw new Error('Seuls les liens HTTPS TikTok et Instagram sont acceptés.');
  }
  if (url.pathname === '/') throw new Error('Colle le lien d’une vidéo, pas celui de la page d’accueil.');
  url.hash = '';
  return url.toString();
}

export function isScrapJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{24,80}$/.test(value);
}

export function isScrapPending(job: ScrapJob | null) {
  return !!job && !['completed', 'failed', 'cancelled'].includes(job.status);
}

export function formatScrapTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return value < 60 ? `${value} s` : `${Math.floor(value / 60)} min ${String(value % 60).padStart(2, '0')} s`;
}

export function scrapProgress(job: ScrapJob, now: number) {
  const stageProgress = Math.max(0, Math.min(100, job.progress ?? 0));
  const fallback = job.status === 'completed' ? 100 : job.status === 'exporting' ? 95
    : job.status === 'cleaning' ? 20 + .75 * stageProgress : job.status === 'detecting' ? 12 + .08 * stageProgress
    : job.status === 'starting' ? 10 : job.status === 'downloading' ? 2 : 0;
  const percent = Math.floor(Math.max(0, Math.min(job.status === 'completed' ? 100 : 99, job.overallProgress ?? fallback)));
  const elapsed = Math.max(0, now - (job.createdAt ?? now));
  const stale = !!job.updatedAt && now - job.updatedAt > 15;
  const remaining = typeof job.etaSeconds === 'number' && job.etaUpdatedAt
    ? Math.ceil(job.etaSeconds - Math.max(0, now - job.etaUpdatedAt)) : null;
  let estimate = 'Estimation dès que le moteur est prêt';
  if (job.status === 'cancelling') estimate = 'Arrêt demandé au serveur…';
  else if (job.status === 'starting') estimate = 'Le démarrage peut prendre 1 à 2 minutes';
  else if (job.status === 'downloading') estimate = 'Temps restant calculé après le téléchargement';
  else if (job.status === 'exporting') estimate = 'Finalisation de la vidéo…';
  else if (['detecting', 'cleaning'].includes(job.status)) {
    estimate = remaining !== null && remaining > 0 && !stale
      ? `Encore environ ${formatScrapTime(Math.max(5, Math.ceil(remaining / 5) * 5))}`
      : 'Estimation en cours de réajustement…';
  }
  return { percent, elapsed: formatScrapTime(elapsed), estimate };
}
