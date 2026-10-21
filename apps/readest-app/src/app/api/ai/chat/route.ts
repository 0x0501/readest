import { validateRequestUser } from '@/libs/auth/verify';
import { streamText, createGateway } from 'ai';
import type { ModelMessage } from 'ai';
import { clientSafeMessage } from '@/libs/errors';

const MAX_MESSAGES = 500;
const MAX_INPUT_CHARS = 500_000;

export async function POST(req: Request): Promise<Response> {
  try {
    const { user, token } = await validateRequestUser(req.headers.get('authorization'));
    if (!user || !token) {
      return Response.json({ error: 'Not authenticated' }, { status: 403 });
    }

    const { messages, system, apiKey, model } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Messages required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (system !== undefined && typeof system !== 'string') {
      return new Response(JSON.stringify({ error: 'Invalid system prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const inputChars = JSON.stringify(messages).length + (system?.length ?? 0);
    if (messages.length > MAX_MESSAGES || inputChars > MAX_INPUT_CHARS) {
      return new Response(JSON.stringify({ error: 'Input too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const gateway = createGateway({ apiKey });
    const languageModel = gateway(model || 'google/gemini-2.5-flash-lite');

    const result = streamText({
      model: languageModel,
      system: system || 'You are a helpful assistant.',
      messages: messages as ModelMessage[],
    });

    return result.toTextStreamResponse();
  } catch (error) {
    const errorMessage = clientSafeMessage(error, 'Unknown error');
    return new Response(JSON.stringify({ error: `Chat failed: ${errorMessage}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
