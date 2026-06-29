/**
 * Vertex AI Gemini client wrapper — Phase-2 F2.2 (ADR-0006), migrated to
 * `@google/genai` (ADR-0008).
 *
 * Responsibilities:
 *  - lazily build a single `GoogleGenAI` client for the configured Gemini
 *    model using Application Default Credentials (ADC). The `@google/genai`
 *    SDK reads `GOOGLE_APPLICATION_CREDENTIALS` automatically — we never
 *    parse service-account keys ourselves and never log their contents.
 *  - expose a single `generate()` entrypoint that issues one round-trip to
 *    Vertex. Multi-turn / multi-tool orchestration lives in the assistant
 *    service (`src/services/assistant.ts`).
 *  - stay completely silent in test / disabled mode so the existing tests
 *    do not touch GCP. `isVertexEnabled()` mirrors `cfg.vertex.enabled`;
 *    every caller MUST gate on it.
 *
 * The exported `VertexClient` interface lets tests inject a fake — see
 * `test/services.assistant.test.ts`.
 *
 * SDK note (ADR-0008): unlike `@google-cloud/vertexai`, the new SDK has no
 * "generative model" cache — every call is `ai.models.generateContent(...)`
 * with the `model` string passed in. We still cache the `GoogleGenAI`
 * instance itself because constructing it eagerly reads ADC credentials.
 */
import {
  GoogleGenAI,
  type Content,
  type GenerateContentResponse,
  type Tool,
  type ToolConfig,
} from '@google/genai';
import { loadConfig } from '../../config/index.js';

/**
 * Minimal request shape — only the fields the assistant service actually
 * sets. Keeping it narrow makes the test fake trivial to author.
 */
export type VertexGenerateRequest = {
  readonly systemInstruction: string;
  readonly contents: Content[];
  readonly tools: Tool[];
  /**
   * Optional function-calling policy for this round-trip. The assistant
   * service uses `mode: ANY` on the FIRST turn to FORCE the model to call a
   * grounding tool (so it can never answer data questions from its own
   * "knowledge" — the ungrounded-hallucination bug, ADR-0006 §5), and
   * `mode: AUTO` on follow-up turns so the model can synthesise a text
   * answer from the tool results. When omitted, Vertex defaults to AUTO.
   */
  readonly toolConfig?: ToolConfig;
};

export type VertexClient = {
  /** True when the SDK is wired and ADC credentials are present. */
  readonly enabled: boolean;
  /**
   * Issue a single `generateContent` round-trip. Throws on transport
   * errors; callers translate that into an `AI_TOOL_ERROR` response.
   */
  generate(req: VertexGenerateRequest): Promise<GenerateContentResponse>;
};

let cached: GoogleGenAI | undefined;

function getAi(): GoogleGenAI {
  if (cached !== undefined) {
    return cached;
  }
  const cfg = loadConfig();
  if (!cfg.vertex.enabled) {
    // Defensive — callers should never reach this branch (gate on
    // `isVertexEnabled()` first).
    throw new Error(
      'Vertex client is disabled — set VERTEX_PROJECT_ID and GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }
  cached = new GoogleGenAI({
    vertexai: true,
    project: cfg.vertex.projectId,
    location: cfg.vertex.region,
  });
  return cached;
}

export function isVertexEnabled(): boolean {
  return loadConfig().vertex.enabled;
}

/**
 * Default production client — talks to the real Vertex API. Tests pass a
 * fake `VertexClient` directly to the assistant service.
 */
export const defaultVertexClient: VertexClient = {
  get enabled(): boolean {
    return isVertexEnabled();
  },
  async generate(req: VertexGenerateRequest): Promise<GenerateContentResponse> {
    const cfg = loadConfig();
    const ai = getAi();
    return ai.models.generateContent({
      model: cfg.vertex.model,
      contents: req.contents,
      config: {
        systemInstruction: req.systemInstruction,
        tools: req.tools,
        // Function-calling policy — forwarded verbatim from the caller. The
        // assistant service forces `mode: ANY` on the first turn so the model
        // grounds every answer in a tool call (anti-hallucination). Omitted ⇒
        // Vertex default (AUTO).
        ...(req.toolConfig !== undefined ? { toolConfig: req.toolConfig } : {}),
        temperature: 0.2, // deterministic-leaning — domain answers, not creative writing
        maxOutputTokens: cfg.vertex.maxOutputTokens,
      },
    });
  },
};

/** TEST-ONLY: drop the memoised SDK client so a new config takes effect. */
export function resetVertexClientCache(): void {
  cached = undefined;
}
