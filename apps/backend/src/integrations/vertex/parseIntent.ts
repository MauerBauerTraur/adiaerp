/**
 * F4.3 (ADR-0014) — Voice transcript → stock-movement intent parser.
 *
 * Telegram voice'dan kelgan transcript (`recognizeShort` chiqishi) shu modul
 * orqali Vertex Gemini'ga uzatiladi va function calling orqali
 * `parse_movements({ movements: [...] })` chaqirig'i qaytariladi.
 *
 * Yondashuv (ADR-0014 §2.2):
 *   1. Bitta `parse_movements` function declaration model'ga e'lon qilinadi.
 *   2. System prompt o'zbekcha — model'ga "har movement uchun action turini
 *      (`adjust_in`/`adjust_out`/`transfer`) ajrat, product_name va qty/unit
 *      ni ayniq ber" deydi.
 *   3. Model bizga mahsulot/lokatsiya ID'sini bermaydi — faqat matn nomi.
 *      ID DB qatlamida `resolveProduct` va `resolveLocationHint` orqali
 *      aniqlanadi (hallucination guard).
 *
 * Caller (`voiceHandler.ts`) qaytarilgan intent[]'ni `assistant_actions`
 * pending qatorlariga aylantiradi.
 */
import {
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
  type Tool,
} from '@google/genai';
import type { AuthPrincipal } from '../../auth/jwt.js';
import {
  defaultVertexClient,
  isVertexEnabled,
  type VertexClient,
} from './client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StockIntentAction = 'adjust_in' | 'adjust_out' | 'transfer';

/** One parsed intent — Vertex faqat nomlarni qaytaradi, ID emas. */
export type ParsedIntent = {
  readonly action: StockIntentAction;
  /** Foydalanuvchi gapidagi mahsulot nomi (DB da `resolveProduct` orqali aniqlanadi). */
  readonly product_name: string;
  readonly qty: number;
  /** Birlik (kg, l, dona, paket, qop, unknown). */
  readonly unit: string;
  /** Manba lokatsiya hint — transfer uchun shart, kirim uchun null. */
  readonly from_location_hint: string | null;
  /** Maqsad lokatsiya hint — kirim/transfer uchun. */
  readonly to_location_hint: string | null;
};

/** parseStockMovementIntent natijasi. */
export type ParseIntentResult = {
  readonly intents: ParsedIntent[];
  /**
   * Vertex bo'sh javob qaytargan yoki function call yo'q bo'lsa — bot
   * foydalanuvchiga "Amal aniqlanmadi" deb javob beradi.
   */
  readonly empty_reason: 'no_function_call' | 'no_intents' | null;
};

// ---------------------------------------------------------------------------
// Function declaration — Gemini'ga e'lon qilinadigan yagona tool
// ---------------------------------------------------------------------------

const parseMovementsDecl: FunctionDeclaration = {
  name: 'parse_movements',
  description:
    'Extract stock movements from the user utterance. Each movement is one ' +
    'logical action (kirim / chiqim / transfer) with a product name, qty and ' +
    'unit. Do not invent product or location ids — the server resolves names ' +
    'to ids. If the utterance has no actionable movement, return an empty array.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      movements: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              description:
                'One of: "adjust_in" (kirim — "keldi", "olib keldim", "tushdi"), ' +
                '"adjust_out" (chiqim — "yo\'qoldi", "buzildi", "tashlandi"), ' +
                '"transfer" (bo\'g\'inlar orasida — "jo\'natdim", "olib bordim").',
            },
            product_name: {
              type: Type.STRING,
              description:
                'Mahsulot nomi foydalanuvchi gapidan AYNAN olinadi (siz tanlamang). ' +
                'Masalan: "un", "shakar", "tort", "yog\'".',
            },
            qty: {
              type: Type.NUMBER,
              description: 'Musbat miqdor. Aniq raqam aytilmasa qty=0 va unit="unknown".',
            },
            unit: {
              type: Type.STRING,
              description:
                'Birlik: "kg", "l", "dona", "paket", "qop", yoki "unknown" agar aniq emas.',
            },
            from_location_hint: {
              type: Type.STRING,
              description:
                'Manba lokatsiya matn nomi (faqat transfer uchun). Masalan: ' +
                '"Markaziy sklad", "Filial-2". Aks holda bo\'sh.',
            },
            to_location_hint: {
              type: Type.STRING,
              description:
                'Maqsad lokatsiya matn nomi (kirim yoki transfer uchun). ' +
                'Masalan: "ombor", "Filial-2".',
            },
          },
          required: ['action', 'product_name', 'qty', 'unit'],
        },
      },
    },
    required: ['movements'],
  },
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildVoiceSystemPrompt(principal: AuthPrincipal): string {
  const roleLine = `Foydalanuvchi roli: ${principal.role}.`;
  const locationLine =
    principal.locationId === null
      ? 'Foydalanuvchi PM — barcha bo\'g\'inlar uchun gapirishi mumkin.'
      : `Foydalanuvchining birlamchi lokatsiyasi (default): ${principal.locationId}.`;

  return [
    'Sen ADIA ERP omborchi-yordamchisisan. Foydalanuvchi o\'zbek (lotin yoki krill) ',
    "yoki rus tilida ombor harakatlari haqida xabar beradi. Sening vazifang — ",
    "transkripsiyani tahlil qilib `parse_movements` funksiyasini chaqirish va ",
    "har bir mantiqiy harakatni alohida `movements[]` elementi sifatida qaytarish.\n\n",
    '## Action turlari\n',
    '- `adjust_in`  — kirim ("keldi", "olib keldim", "tushdi", "qabul qildim").\n',
    '- `adjust_out` — chiqim ("yo\'qoldi", "buzildi", "tashladim", "tushib qoldi").\n',
    '- `transfer`  — bo\'g\'inlar orasida ko\'chirish ("jo\'natdim", "olib bordim", "berdim").\n\n',
    '## Birliklar\n',
    'kg, l, dona, paket, qop. Aniq aytilmasa `unit="unknown"`.\n\n',
    '## Mahsulot va lokatsiya\n',
    '- Mahsulot nomini AYNAN foydalanuvchi gapidagi shaklda yozing — siz o\'zingiz ',
    'nomni o\'zgartirib yubormang ("un Oliy nav" deb yozsa "Un" deb qisqartirmang).\n',
    '- Lokatsiya nomini matn shaklida qaytaring (`from_location_hint` / ',
    '`to_location_hint`). Server o\'zi ID ga aylantiradi.\n',
    '- Hech qachon product_id yoki location_id qaytarmang.\n\n',
    '## Misollar\n',
    '"Bugun omborga 500 kg un va 50 l yog\' keldi" → 2 ta `adjust_in`: ',
    '[{action:"adjust_in", product_name:"un", qty:500, unit:"kg", to_location_hint:"ombor"}, ',
    '{action:"adjust_in", product_name:"yog\'", qty:50, unit:"l", to_location_hint:"ombor"}].\n',
    '"Filial-2 ga 5 ta tort jo\'natdim" → 1 ta `transfer`: ',
    '[{action:"transfer", product_name:"tort", qty:5, unit:"dona", to_location_hint:"Filial-2"}].\n',
    '"Salom, qalaysiz" → bo\'sh massiv (movements: []).\n\n',
    roleLine, ' ', locationLine, '\n',
    'Har doim `parse_movements` ni chaqir — matn bilan emas, funksiya bilan javob ber.',
  ].join('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Bitta intent ob'ektining ham `action`, ham `product_name`, ham `qty` borligini tasdiqlash. */
function shapeIntent(raw: unknown): ParsedIntent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const action = typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : '';
  if (action !== 'adjust_in' && action !== 'adjust_out' && action !== 'transfer') {
    return null;
  }
  const productName =
    typeof obj.product_name === 'string' ? obj.product_name.trim() : '';
  if (productName === '') return null;
  const qtyRaw = typeof obj.qty === 'number' ? obj.qty : Number(obj.qty);
  // qty=0 ham (unknown) ruxsat — voiceHandler clarification flow bilan ishlaydi.
  const qty = Number.isFinite(qtyRaw) && qtyRaw >= 0 ? qtyRaw : 0;
  const unitRaw = typeof obj.unit === 'string' ? obj.unit.trim().toLowerCase() : '';
  const unit = unitRaw === '' ? 'unknown' : unitRaw;
  const fromHint =
    typeof obj.from_location_hint === 'string' && obj.from_location_hint.trim() !== ''
      ? obj.from_location_hint.trim()
      : null;
  const toHint =
    typeof obj.to_location_hint === 'string' && obj.to_location_hint.trim() !== ''
      ? obj.to_location_hint.trim()
      : null;
  return {
    action,
    product_name: productName,
    qty,
    unit,
    from_location_hint: fromHint,
    to_location_hint: toHint,
  };
}

function collectFunctionCalls(parts: readonly Part[]): FunctionCall[] {
  const calls: FunctionCall[] = [];
  for (const p of parts) {
    if ('functionCall' in p && p.functionCall !== undefined) {
      calls.push(p.functionCall);
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

/**
 * Vertex orqali transkripsiyani intent[] ga aylantirish.
 *
 * Test seam: caller `client` ni override qila oladi (`__forTesting`'da
 * to'g'ridan-to'g'ri parse helperlar ham mavjud).
 */
export async function parseStockMovementIntent(
  transcript: string,
  principal: AuthPrincipal,
  client?: VertexClient,
): Promise<ParseIntentResult> {
  const ai = client ?? defaultVertexClient;
  if (!ai.enabled && !isVertexEnabled() && client === undefined) {
    // Disabled mode — bo'sh chiqar (voiceHandler "Vertex o'chirilgan" deydi).
    return { intents: [], empty_reason: 'no_function_call' };
  }

  const contents: Content[] = [
    {
      role: 'user',
      parts: [{ text: transcript }],
    },
  ];
  const tools: Tool[] = [{ functionDeclarations: [parseMovementsDecl] }];

  const response = await ai.generate({
    systemInstruction: buildVoiceSystemPrompt(principal),
    contents,
    tools,
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const calls = collectFunctionCalls(parts);
  if (calls.length === 0) {
    return { intents: [], empty_reason: 'no_function_call' };
  }
  // Bizning bitta tool — birinchisini olamiz.
  const call = calls[0]!;
  const rawArgs = (call.args ?? {}) as Record<string, unknown>;
  const movementsRaw = rawArgs.movements;
  if (!Array.isArray(movementsRaw)) {
    return { intents: [], empty_reason: 'no_intents' };
  }
  const intents: ParsedIntent[] = [];
  for (const m of movementsRaw) {
    const shaped = shapeIntent(m);
    if (shaped !== null) intents.push(shaped);
  }
  return {
    intents,
    empty_reason: intents.length === 0 ? 'no_intents' : null,
  };
}

// ---------------------------------------------------------------------------
// TEST seams
// ---------------------------------------------------------------------------

/** Test-only — function declarationni inspect qilish (snapshot uchun). */
export const __forTesting = {
  parseMovementsDecl,
  shapeIntent,
  buildVoiceSystemPrompt,
};
