/**
 * F4.3 (ADR-0014) — parseStockMovementIntent unit tests.
 *
 * Mock Vertex client orqali turli function call natijalarini sinaymiz.
 * Real Vertex'ga tegmaymiz (CI offline).
 */
import { describe, expect, it } from 'vitest';
import type { Content, GenerateContentResponse, Tool } from '@google/genai';
import {
  parseStockMovementIntent,
  __forTesting,
} from '../src/integrations/vertex/parseIntent.js';
import type { VertexClient } from '../src/integrations/vertex/client.js';
import type { AuthPrincipal } from '../src/auth/jwt.js';

function principal(): AuthPrincipal {
  return {
    userId: 1,
    role: 'raw_warehouse_manager',
    locationId: 10,
    locationIds: [10],
    activeLocationId: 10,
  };
}

function mockClient(parts: unknown[]): VertexClient {
  return {
    enabled: true,
    async generate(_req: {
      systemInstruction: string;
      contents: Content[];
      tools: Tool[];
    }): Promise<GenerateContentResponse> {
      return {
        candidates: [
          {
            content: { parts: parts as Parameters<typeof Object>[0][] },
          },
        ],
      } as unknown as GenerateContentResponse;
    },
  };
}

describe('parseStockMovementIntent', () => {
  it('returns intents[] from a parse_movements function call', async () => {
    const client = mockClient([
      {
        functionCall: {
          name: 'parse_movements',
          args: {
            movements: [
              {
                action: 'adjust_in',
                product_name: 'un',
                qty: 500,
                unit: 'kg',
                to_location_hint: 'ombor',
              },
              {
                action: 'adjust_in',
                product_name: "yog'",
                qty: 50,
                unit: 'l',
                to_location_hint: 'ombor',
              },
            ],
          },
        },
      },
    ]);
    const result = await parseStockMovementIntent(
      "Bugun omborga 500 kg un va 50 l yog' keldi",
      principal(),
      client,
    );
    expect(result.empty_reason).toBeNull();
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0]).toMatchObject({
      action: 'adjust_in',
      product_name: 'un',
      qty: 500,
      unit: 'kg',
      to_location_hint: 'ombor',
    });
    expect(result.intents[1]?.product_name).toBe("yog'");
  });

  it('returns empty intents + no_function_call when model gave only text', async () => {
    const client = mockClient([{ text: 'Salom, qalaysiz?' }]);
    const result = await parseStockMovementIntent('Salom', principal(), client);
    expect(result.intents).toHaveLength(0);
    expect(result.empty_reason).toBe('no_function_call');
  });

  it('returns empty intents + no_intents when movements=[]', async () => {
    const client = mockClient([
      {
        functionCall: {
          name: 'parse_movements',
          args: { movements: [] },
        },
      },
    ]);
    const result = await parseStockMovementIntent('xyz', principal(), client);
    expect(result.intents).toHaveLength(0);
    expect(result.empty_reason).toBe('no_intents');
  });

  it('filters out malformed intents (bad action / missing product_name)', async () => {
    const client = mockClient([
      {
        functionCall: {
          name: 'parse_movements',
          args: {
            movements: [
              { action: 'unknown_action', product_name: 'un', qty: 5, unit: 'kg' },
              { action: 'adjust_in', product_name: '', qty: 5, unit: 'kg' },
              { action: 'adjust_in', product_name: 'shakar', qty: 3, unit: 'kg' },
            ],
          },
        },
      },
    ]);
    const result = await parseStockMovementIntent('foo', principal(), client);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.product_name).toBe('shakar');
  });

  it('transfer intent — keeps from/to location hints', async () => {
    const client = mockClient([
      {
        functionCall: {
          name: 'parse_movements',
          args: {
            movements: [
              {
                action: 'transfer',
                product_name: 'tort',
                qty: 5,
                unit: 'dona',
                from_location_hint: 'Markaziy sklad',
                to_location_hint: 'Filial-2',
              },
            ],
          },
        },
      },
    ]);
    const result = await parseStockMovementIntent(
      "Filial-2 ga 5 ta tort jo'natdim",
      principal(),
      client,
    );
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0]?.action).toBe('transfer');
    expect(result.intents[0]?.from_location_hint).toBe('Markaziy sklad');
    expect(result.intents[0]?.to_location_hint).toBe('Filial-2');
  });

  it('shapeIntent: rejects ambiguous unit/qty but keeps shape', () => {
    expect(
      __forTesting.shapeIntent({
        action: 'adjust_in',
        product_name: 'un',
        qty: -5,
        unit: '',
      }),
    ).toMatchObject({ qty: 0, unit: 'unknown' });
  });

  it('exposes parse_movements function declaration', () => {
    const decl = __forTesting.parseMovementsDecl;
    expect(decl.name).toBe('parse_movements');
    expect(decl.parameters).toBeDefined();
  });
});
