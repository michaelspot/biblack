import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { fetch } from 'expo/fetch';

import { getApiBaseUrl, normalizeApiBaseUrl } from '../config';
import { isScrapJobId, isScrapPending, normalizeScrapUrl, SCRAP_LABELS, type ScrapJob } from '../scrap';
import { errorMessage } from '../utils';

interface SavedScrap {
  baseUrl: string;
  sourceUrl: string;
  job: ScrapJob;
  submitted: boolean;
  cancellationRequested?: boolean;
}

const savedFile = () => new File(Paths.document, 'scaylit-scrap-v1.json');

function persist(value: SavedScrap) {
  const file = savedFile();
  file.create({ overwrite: true, intermediates: true });
  file.write(JSON.stringify(value));
}

async function requestJob(saved: SavedScrap, signal: AbortSignal): Promise<ScrapJob> {
  const cancelling = saved.cancellationRequested;
  const response = await fetch(`${saved.baseUrl}/api/scrap${saved.submitted || cancelling ? `?id=${saved.job.id}` : ''}`, {
    method: cancelling ? 'DELETE' : saved.submitted ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(!saved.submitted && !cancelling ? { body: JSON.stringify({ id: saved.job.id, url: saved.sourceUrl, removeText: saved.job.removeText }) } : {}),
    signal,
  });
  const data = await response.json() as ScrapJob & { error?: string };
  if (!response.ok) {
    if (cancelling) throw new Error('Arrêt non confirmé. Vérifie ta connexion ; nouvelle tentative automatique.');
    if (response.status === 404 && !saved.submitted) {
      return { ...saved.job, status: 'failed', error: 'Scrap n’est pas encore installé sur ce serveur. Il faut mettre à jour le backend et connecter Cobalt et Modal.' };
    }
    // A definite rejection is terminal; network/5xx failures can resume the same job.
    if ([400, 403, 404, 409, 410, 422, 503].includes(response.status)) {
      return { ...saved.job, status: 'failed', error: data.error || 'Le service Scrap est indisponible.' };
    }
    throw new Error(data.error || 'Connexion interrompue. Le suivi va reprendre automatiquement.');
  }
  if (data.id !== saved.job.id || !Object.hasOwn(SCRAP_LABELS, data.status) ||
    (data.status === 'completed' && (!data.url || !data.name))) {
    throw new Error('Réponse Scrap invalide. Nouvelle tentative de suivi…');
  }
  return { ...data, createdAt: data.createdAt ?? saved.job.createdAt,
    ...(cancelling ? { removeText: saved.job.removeText } : {}) };
}

export function useScrapJob(active: boolean) {
  const [saved, setSaved] = useState<SavedScrap | null>(null);
  const [ready, setReady] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const file = savedFile();
        if (file.exists) {
          const value = JSON.parse(await file.text()) as SavedScrap;
          if (isScrapJobId(value.job?.id) && Object.hasOwn(SCRAP_LABELS, value.job.status) &&
            typeof value.job.removeText === 'boolean' && typeof value.submitted === 'boolean') {
            value.baseUrl = normalizeApiBaseUrl(value.baseUrl);
            value.sourceUrl = normalizeScrapUrl(value.sourceUrl);
            if (value.job.expiresAt && value.job.expiresAt <= Date.now() / 1000) {
              value.job = { ...value.job, status: 'failed', error: 'Cette vidéo a expiré. Relance le lien pour la récupérer.' };
            }
            if (!cancelled) setSaved(value);
          }
        }
      } catch { /* Ignore an obsolete or incomplete local snapshot. */ }
      finally { if (!cancelled) setReady(true); }
    })();
    const listener = AppState.addEventListener('change', next => setForeground(next === 'active'));
    return () => { cancelled = true; listener.remove(); };
  }, []);

  const pending = isScrapPending(saved?.job ?? null);
  const id = saved?.job.id;
  const cancellationRequested = saved?.cancellationRequested;
  useEffect(() => {
    const current = savedRef.current;
    if (active && current?.job.status === 'completed' && current.job.expiresAt && current.job.expiresAt <= Date.now() / 1000) {
      const next: SavedScrap = { ...current, job: { ...current.job, status: 'failed', error: 'Cette vidéo a expiré. Relance le lien pour la récupérer.' } };
      savedRef.current = next;
      setSaved(next);
      try { persist(next); } catch { /* Keep the expiration state in memory. */ }
    }
  }, [active, foreground, id]);
  useEffect(() => {
    if (!ready || (!active && !cancellationRequested) || !foreground || !pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const poll = async () => {
      const current = savedRef.current;
      if (!current || !isScrapPending(current.job)) return;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 25_000);
      try {
        const job = await requestJob(current, controller.signal);
        if (stopped || savedRef.current?.cancellationRequested !== current.cancellationRequested) return;
        const next = { ...current, job, submitted: true,
          cancellationRequested: current.cancellationRequested && isScrapPending(job) };
        savedRef.current = next;
        setSaved(next);
        setConnectionError(null);
        try { persist(next); } catch { /* In-memory tracking remains available. */ }
      } catch (error) {
        if (!stopped) setConnectionError(errorMessage(error, 'Connexion interrompue. Reprise automatique…'));
      } finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [active, foreground, id, pending, ready, cancellationRequested]);

  const start = useCallback((url: string, removeText: boolean) => {
    if (isScrapPending(savedRef.current?.job ?? null)) return;
    const sourceUrl = normalizeScrapUrl(url);
    const id = `${Date.now().toString(36)}-${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('')}`;
    const value: SavedScrap = {
      baseUrl: getApiBaseUrl(), sourceUrl, submitted: false,
      job: { id, status: 'queued', removeText, createdAt: Date.now() / 1000, overallProgress: 0 },
    };
    persist(value);
    savedRef.current = value;
    setConnectionError(null);
    setSaved(value);
  }, []);

  const stop = useCallback(() => {
    const current = savedRef.current;
    if (!current || !isScrapPending(current.job) || current.cancellationRequested) return;
    const next: SavedScrap = { ...current, cancellationRequested: true,
      job: { ...current.job, status: 'cancelling', etaSeconds: null } };
    savedRef.current = next;
    setSaved(next);
    setConnectionError(null);
    try { persist(next); } catch { /* Still send Stop immediately if local storage is full. */ }
  }, []);

  return { job: saved?.job ?? null, sourceUrl: saved?.sourceUrl, ready, pending, connectionError, start, stop };
}
