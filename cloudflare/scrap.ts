import { isScrapJobId, normalizeScrapUrl, SCRAP_LABELS, type ScrapJob } from '../src/scrap';

export interface ScrapEnv {
  SCRAP_SERVICE_URL?: string;
  SCRAP_SERVICE_TOKEN?: string;
  SCRAP_RATE_LIMIT?: { limit: (options: { key: string }) => Promise<{ success: boolean }> };
}

const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
});

export async function handleScrap(request: Request, env: ScrapEnv, fetcher: typeof fetch = fetch) {
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return json({ error: 'Méthode non autorisée.' }, 405);
  let payload: { id: string; url: string; removeText: boolean } | undefined;
  let id = new URL(request.url).searchParams.get('id');
  if (request.method === 'POST') {
    if (Number(request.headers.get('content-length') || 0) > 4096) return json({ error: 'Requête trop volumineuse.' }, 413);
    try {
      const raw = await request.text();
      if (raw.length > 4096) return json({ error: 'Requête trop volumineuse.' }, 413);
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (typeof body.removeText !== 'boolean' || !isScrapJobId(body.id)) throw new Error('Paramètres Scrap invalides.');
      payload = { id: body.id, url: normalizeScrapUrl(body.url), removeText: body.removeText };
      id = body.id;
    } catch (caught) {
      return json({ error: caught instanceof Error ? caught.message : 'Requête invalide.' }, 400);
    }
  }
  if (!isScrapJobId(id)) return json({ error: 'Identifiant Scrap invalide.' }, 400);
  if (!env.SCRAP_SERVICE_URL || !env.SCRAP_SERVICE_TOKEN) {
    return json({ error: 'Scrap n’est pas encore activé sur ce serveur. Il faut connecter Cobalt et le service de traitement Modal.' }, 503);
  }
  if (request.method === 'POST' && env.SCRAP_RATE_LIMIT) {
    const rate = await env.SCRAP_RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!rate.success) return json({ error: 'Trop de demandes. Réessaie dans une minute.' }, 429);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const base = new URL(env.SCRAP_SERVICE_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid service URL');
    const upstream = await fetcher(`${base.toString().replace(/\/$/, '')}/jobs${payload ? '' : `/${id}`}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${env.SCRAP_SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: controller.signal,
      // Workers supports manual/follow only. Never forward the token to a redirect target.
      redirect: 'manual',
    });
    if (upstream.status >= 300 && upstream.status < 400) throw new Error('Unexpected service redirect');
    const data = await upstream.json() as ScrapJob & { key?: string; detail?: string };
    if (!upstream.ok) {
      const message = data.error || data.detail;
      return json({ error: typeof message === 'string' ? message : 'Le service Scrap est temporairement indisponible.' },
        [400, 404, 409, 410, 422, 429].includes(upstream.status) ? upstream.status : 502);
    }
    if (data.id !== id || !Object.hasOwn(SCRAP_LABELS, data.status) || typeof data.removeText !== 'boolean') throw new Error('Invalid job');
    // Only serve this job’s own final MP4 through the existing R2 media route.
    if (data.status === 'completed' && data.key !== `scrap/results/${id}.mp4`) throw new Error('Invalid result');
    return json({
      id, status: data.status, removeText: data.removeText,
      ...(typeof data.progress === 'number' && Number.isFinite(data.progress) && data.progress >= 0 && data.progress <= 100 ? { progress: Math.floor(data.progress) } : {}),
      ...Object.fromEntries(['overallProgress', 'createdAt', 'updatedAt', 'etaSeconds', 'etaUpdatedAt'].flatMap(field => {
        const value = data[field as keyof ScrapJob];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
          (field !== 'overallProgress' || value <= 100) ? [[field, value]] : [];
      })),
      ...(data.error ? { error: data.error } : {}),
      ...(data.note ? { note: data.note } : {}),
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
      ...(data.status === 'completed' ? {
        url: `${new URL(request.url).origin}/media/${data.key}`,
        name: `scrap-${data.removeText ? 'sans-texte-' : ''}${id}`,
      } : {}),
    }, payload ? 202 : 200);
  } catch {
    return json({ error: 'Le service Scrap ne répond pas. Le suivi va reprendre automatiquement.' }, 502);
  } finally { clearTimeout(timeout); }
}
