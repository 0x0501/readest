import { getCloudflareContext } from '@opennextjs/cloudflare';
import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { SHARE_PRESIGN_TTL_SECONDS } from '@/services/constants';
import { getDownloadSignedUrl } from '@/utils/object';

// Minimal local typing for the service binding (the project does not depend on
// @cloudflare/workers-types). Mirrors the pattern in `src/libs/db/index.ts`.
interface Fetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface CloudflareEnv {
  SHARE_OG?: Fetcher;
}

interface RouteParams {
  params: Promise<{ token: string }>;
}

// GET /api/share/[token]/og.png — server-rendered branded card for chat
// unfurls. Stable URL, cached for an hour: unfurlers (iMessage, WhatsApp,
// Twitter, Slack) cache aggressively, so a short-lived signed cover URL would
// break previews after expiry. By proxying through this route we get a stable
// URL even though the underlying R2 object is presigned per-fetch.
//
// The drawing itself lives in the `readest-share-og` Worker
// (`workers/share-og`), reached through the SHARE_OG service binding. Satori's
// resvg.wasm alone is 1.3 MB, and Workers are capped on *compressed* script
// size, so ~2.3 MB of image-rendering machinery does not belong in a bundle
// whose every other path serves the reader. This route keeps the work it had
// to do anyway — resolve the token, presign the cover — and hands the renderer
// the two strings and one URL it needs.
//
// The route file is `.ts` so the Tauri static-export build drops it via
// `pageExtensions: ['jsx', 'tsx']` in next.config.mjs — same gating used by
// every other share API route.
export async function GET(_request: Request, { params }: RouteParams) {
  const { token } = await params;

  const result = await withDb((db) => resolveActiveShare(db, token));
  if (!result.ok) {
    const { status, body } = rejectionToHttp(result.reason);
    return NextResponse.json(body, { status });
  }
  const { share } = result;

  let coverUrl: string | null = null;
  if (share.coverFileKey) {
    try {
      coverUrl = await getDownloadSignedUrl(share.coverFileKey, SHARE_PRESIGN_TTL_SECONDS);
    } catch (err) {
      console.error('Share og.png cover presign failed:', err);
      // Fall through to the text-only card.
    }
  }

  const renderer = (getCloudflareContext().env as Partial<CloudflareEnv> | undefined)?.SHARE_OG;
  if (!renderer) {
    throw new Error('The SHARE_OG service binding is not configured.');
  }

  // The hostname is ignored: a service binding dispatches straight to the
  // bound Worker's fetch handler without leaving the runtime.
  return renderer.fetch('https://share-og/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: share.bookTitle, author: share.bookAuthor, coverUrl }),
  });
}
