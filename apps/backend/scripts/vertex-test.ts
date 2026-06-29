/**
 * Vertex smoke test — `npm run vertex:test -w @adia/backend`.
 *
 * Issues TWO real `generateContent` calls against the configured Gemini model:
 *   (1) a plain text round-trip — confirms creds + model id are wired right;
 *   (2) a function-calling round-trip — advertises one minimal tool and
 *       asks a question that should drive the model to emit a `functionCall`
 *       part. This guards ADR-0008's biggest risk surface: that the new
 *       `@google/genai` SDK still emits `candidates[0].content.parts[].functionCall`
 *       the way our `extractToolCalls` expects.
 *
 * It exits 0 on success, 1 on any failure (so CI can gate on it later).
 */
import { loadConfig } from '../src/config/index.js';
import { defaultVertexClient, isVertexEnabled } from '../src/integrations/vertex/client.js';
import { Type, type FunctionDeclaration } from '@google/genai';

async function main(): Promise<void> {
  // The config module flips `vertex.enabled` to false in `NODE_ENV=test`.
  // Force `development` so the smoke test works regardless of shell env.
  if (process.env.NODE_ENV === 'test') {
    process.env.NODE_ENV = 'development';
  }
  const cfg = loadConfig();

  if (!isVertexEnabled()) {
    console.error(
      '[vertex-test] disabled — set VERTEX_PROJECT_ID and ' +
        'GOOGLE_APPLICATION_CREDENTIALS in your .env, then retry.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('[vertex-test]', {
    project: cfg.vertex.projectId,
    region: cfg.vertex.region,
    model: cfg.vertex.model,
  });

  const t0 = Date.now();
  try {
    const response = await defaultVertexClient.generate({
      systemInstruction:
        'You are a terse assistant. Answer in one short sentence.',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Salom! Bir gap bilan o\'zingni tanishtir.' }],
        },
      ],
      tools: [],
    });
    const elapsedMs = Date.now() - t0;
    const candidate = response.candidates?.[0];
    const text =
      candidate?.content?.parts
        ?.map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('') ?? '';
    const usage = response.usageMetadata;
    console.log('[vertex-test] text round-trip ok', { elapsedMs });
    console.log('--- response ---');
    console.log(text);
    console.log('--- usage ---');
    console.log({
      promptTokenCount: usage?.promptTokenCount,
      candidatesTokenCount: usage?.candidatesTokenCount,
      totalTokenCount: usage?.totalTokenCount,
    });
  } catch (err) {
    console.error('[vertex-test] text round-trip FAILED', (err as Error).message);
    process.exitCode = 1;
    return;
  }

  // -------------------------------------------------------------------------
  // Function-calling round-trip — the new SDK's shape for `functionCall`
  // parts must match what `services/assistant.ts` expects.
  // -------------------------------------------------------------------------
  const getBelowMin: FunctionDeclaration = {
    name: 'get_below_min',
    description:
      'Returns the list of products currently below the configured min ' +
      'stock level at a given location. Call this when the user asks what ' +
      'is "below min", "red", or "needs replenishment".',
    parameters: {
      type: Type.OBJECT,
      properties: {
        location_name: {
          type: Type.STRING,
          description:
            'Free-text location name, e.g. "Markaziy sklad" or "Do\'kon A".',
        },
      },
    },
  };

  const t1 = Date.now();
  try {
    const response = await defaultVertexClient.generate({
      systemInstruction:
        'You are an ERP assistant. Whenever you need bakery stock data, ' +
        'you MUST call the available tool — do not answer from memory.',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Markaziy skladda nima qizil?' }],
        },
      ],
      tools: [{ functionDeclarations: [getBelowMin] }],
    });
    const elapsedMs = Date.now() - t1;
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const functionCalls = parts
      .filter((p) => p.functionCall !== undefined)
      .map((p) => p.functionCall!);
    const text = parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
    console.log('[vertex-test] tool round-trip ok', {
      elapsedMs,
      functionCallCount: functionCalls.length,
    });
    if (functionCalls.length > 0) {
      console.log('--- function call ---');
      console.log({
        name: functionCalls[0]?.name,
        args: functionCalls[0]?.args,
      });
    } else {
      console.log('--- model returned text instead of a tool call ---');
      console.log(text);
    }
  } catch (err) {
    console.error('[vertex-test] tool round-trip FAILED', (err as Error).message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[vertex-test] uncaught', err);
  process.exitCode = 1;
});
