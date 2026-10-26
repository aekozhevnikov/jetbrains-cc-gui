import { STORAGE_KEYS } from '../types/provider';
import type { CodexCustomModel } from '../types/provider';
import type { ModelInfo } from '../components/ChatInputBox/types';
import { apply1MContextSuffix, normalizeClaudeModelId } from '../components/ChatInputBox/types';

/**
 * Read the user-defined Claude models from localStorage.
 *
 * Entries are tagged `isCustom` so downstream code (model dropdown, alias
 * normalization) can tell them apart from the built-in catalog. A custom
 * model id is the user's explicit choice and must never be rewritten, even
 * when it also appears in the retired-model migration table.
 */
export function readCustomClaudeModels(): ModelInfo[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return [];
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored) as CodexCustomModel[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((m): m is CodexCustomModel => !!m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim().length > 0)
      .map(m => ({
        id: m.id,
        label: m.label || m.id,
        description: m.description,
        isCustom: true,
      }));
  } catch {
    return [];
  }
}

/**
 * Ids of the user-defined Claude models, for passing to normalizeClaudeModelId.
 */
export function readCustomClaudeModelIds(): Set<string> {
  return new Set(readCustomClaudeModels().map(m => m.id));
}

/**
 * Model id to send to Java in the load_session payload for a Claude history
 * session.
 *
 * Java stores the payload verbatim (it cannot tell user-defined custom ids
 * from built-ins), so the webview — the owner of the custom model list —
 * applies the safe half of the migration here: custom ids pass through
 * untouched, retired built-in ids map to their live replacement. The [1m]
 * context suffix is preserved when the model supports it.
 */
export function normalizeClaudeModelForBridge(modelId: string): string {
  const normalized = normalizeClaudeModelId(modelId, readCustomClaudeModelIds());
  const hadLongContext = /\[1m\]$/i.test(modelId);
  return apply1MContextSuffix(normalized, hadLongContext);
}
