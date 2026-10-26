import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeClaudeModelForBridge, readCustomClaudeModelIds, readCustomClaudeModels } from './customClaudeModels';

describe('customClaudeModels', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns an empty list when nothing is stored', () => {
    expect(readCustomClaudeModels()).toEqual([]);
    expect(readCustomClaudeModelIds().size).toBe(0);
  });

  it('tags every stored entry as custom and falls back to the id as label', () => {
    localStorage.setItem('claude-custom-models', JSON.stringify([
      { id: 'claude-opus-4-6', label: 'Opus 4.6', description: 'mine' },
      { id: 'claude-opus-4-8' },
    ]));

    expect(readCustomClaudeModels()).toEqual([
      { id: 'claude-opus-4-6', label: 'Opus 4.6', description: 'mine', isCustom: true },
      { id: 'claude-opus-4-8', label: 'claude-opus-4-8', description: undefined, isCustom: true },
    ]);
    expect([...readCustomClaudeModelIds()]).toEqual(['claude-opus-4-6', 'claude-opus-4-8']);
  });

  it('drops malformed entries and survives invalid JSON', () => {
    localStorage.setItem('claude-custom-models', JSON.stringify([
      null, 'str', { id: '' }, { id: '  ' }, { label: 'no id' }, { id: 'ok' },
    ]));
    expect(readCustomClaudeModels().map(m => m.id)).toEqual(['ok']);

    localStorage.setItem('claude-custom-models', '{not json');
    expect(readCustomClaudeModels()).toEqual([]);

    localStorage.setItem('claude-custom-models', JSON.stringify({ id: 'not-an-array' }));
    expect(readCustomClaudeModels()).toEqual([]);
  });

  describe('normalizeClaudeModelForBridge', () => {
    it('keeps a custom id verbatim even when it sits in the retired table', () => {
      localStorage.setItem('claude-custom-models', JSON.stringify([
        { id: 'claude-opus-4-8', label: 'My Opus 4.8' },
      ]));
      expect(normalizeClaudeModelForBridge('claude-opus-4-8')).toBe('claude-opus-4-8');
    });

    it('migrates a retired built-in id to its live replacement', () => {
      expect(normalizeClaudeModelForBridge('claude-sonnet-4-6')).toBe('claude-sonnet-5');
      expect(normalizeClaudeModelForBridge('claude-opus-4-8')).toBe('claude-opus-5');
    });

    it('passes live and unknown ids through unchanged', () => {
      expect(normalizeClaudeModelForBridge('claude-sonnet-5')).toBe('claude-sonnet-5');
      expect(normalizeClaudeModelForBridge('MiniMax-M2.5')).toBe('MiniMax-M2.5');
    });

    it('preserves the [1m] suffix when the normalized model supports it', () => {
      localStorage.setItem('claude-custom-models', JSON.stringify([{ id: 'my-haiku-custom' }]));
      // sonnet-5 supports 1M context, so the suffix survives migration
      expect(normalizeClaudeModelForBridge('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-5[1m]');
      // haiku models do not support 1M context, so the suffix is dropped
      expect(normalizeClaudeModelForBridge('my-haiku-custom[1m]')).toBe('my-haiku-custom');
    });
  });
});
