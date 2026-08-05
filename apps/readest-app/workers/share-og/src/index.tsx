import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import satori, { init as initYoga } from 'satori/standalone';
import yogaWasm from 'satori/yoga.wasm';
import { textOnlyCard, withCoverCard } from './card';
import geistRegular from './Geist-Regular.ttf';

// Renders the share unfurl card. Lives outside the web app because satori's
// resvg.wasm alone is 1.3 MB and Workers are capped on compressed script size;
// this route was ~2.3 MB of a bundle that never renders an image on any other
// path. Reached only through the SHARE_OG service binding, so the caller has
// already resolved the token and presigned the cover — this Worker holds no
// database or storage credentials and answers to nothing public.

const WIDTH = 1200;
const HEIGHT = 630;

// Satori's default build inlines its WASM as base64 and instantiates it at
// runtime, which workerd forbids. The standalone build takes the compiled
// module instead — one init per isolate, shared by every later request.
let ready: Promise<void> | undefined;
const ensureReady = () =>
  (ready ??= (async () => {
    await initYoga(yogaWasm);
    await initWasm(resvgWasm);
  })());

interface RenderRequest {
  title: string;
  author: string | null;
  // Presigned by the caller; short-lived and fetched once, here, so the image
  // bytes never cross the service binding.
  coverUrl: string | null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const { title, author, coverUrl } = await request.json<RenderRequest>();
    await ensureReady();

    let coverDataUrl: string | null = null;
    if (coverUrl) {
      try {
        const response = await fetch(coverUrl);
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          const contentType = response.headers.get('content-type') ?? 'image/jpeg';
          coverDataUrl = `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
        }
      } catch (err) {
        console.error('Share og.png cover fetch failed:', err);
        // Fall through to text-only card.
      }
    }

    const svg = await satori(
      coverDataUrl ? withCoverCard(coverDataUrl, title, author) : textOnlyCard(title, author),
      {
        width: WIDTH,
        height: HEIGHT,
        // The cards ask for `serif`; registering the single shipped face under
        // that name is what `next/og` effectively did with its bundled Geist.
        fonts: [{ name: 'serif', data: geistRegular, weight: 400, style: 'normal' }],
      },
    );

    const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();

    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        // Unfurlers (iMessage, WhatsApp, Twitter, Slack) cache aggressively,
        // which is the whole reason this URL is stable rather than presigned.
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  },
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};
