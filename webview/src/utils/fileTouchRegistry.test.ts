import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearFileTouchRegistry,
  getDistinctActorsForPath,
  isMultiActorPath,
  loadFileTouchMap,
  recordFileTouches,
  subscribeFileTouches,
  wasTouchedOutsideSession,
} from './fileTouchRegistry';

describe('fileTouchRegistry', () => {
  const store = new Map<string, string>();
  const STORAGE_KEY = 'ccgui-file-touch-registry-v1';

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records touches from two sessions on the same file as multi-actor', () => {
    const path = '/proj/name.js';
    const now = Date.now();
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), now);
    recordFileTouches([path], 'AI2', new Map([[path, ['main']]]), now + 1);

    expect(isMultiActorPath(path)).toBe(true);
    expect(getDistinctActorsForPath(path)).toHaveLength(2);
    expect(wasTouchedOutsideSession(path, 'AI2')).toBe(true);
    expect(wasTouchedOutsideSession(path, 'AI1')).toBe(true);
  });

  it('two agents in one session are multi-actor', () => {
    const path = '/proj/x.ts';
    recordFileTouches([path], 'sess', new Map([[path, ['main', 'task-a']]]), Date.now());
    expect(isMultiActorPath(path)).toBe(true);
  });

  it('single session single agent is not multi-actor', () => {
    const path = '/proj/y.ts';
    const now = Date.now();
    recordFileTouches([path], 'sess', new Map([[path, ['main']]]), now);
    recordFileTouches([path], 'sess', new Map([[path, ['main']]]), now + 1);
    expect(isMultiActorPath(path)).toBe(false);
    expect(wasTouchedOutsideSession(path, 'sess')).toBe(false);
  });

  it('clear empties registry', () => {
    recordFileTouches(['/a'], 's', new Map([['/a', ['main']]]));
    expect(Object.keys(loadFileTouchMap()).length).toBeGreaterThan(0);
    clearFileTouchRegistry();
    expect(loadFileTouchMap()).toEqual({});
  });

  it('notifies subscribers of same-window writes and clearing without extra reads', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFileTouches(listener);
    try {
      const reads = vi.spyOn(localStorage, 'getItem');
      const next = recordFileTouches(['/a'], 'session', new Map());
      expect(listener).toHaveBeenCalledExactlyOnceWith(next);
      expect(reads).toHaveBeenCalledTimes(1);
      clearFileTouchRegistry();
      expect(listener).toHaveBeenLastCalledWith({});
      unsubscribe();
      listener.mockClear();
      recordFileTouches(['/a'], 'session', new Map());
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('observes other-window storage events only for the registry', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFileTouches(listener);
    try {
      const next = { '/a': [{ sessionId: 'other', agentId: 'main', updatedAt: Date.now() }] };
      store.set(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
      expect(listener).not.toHaveBeenCalled();
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
      expect(listener).toHaveBeenLastCalledWith(next);
    } finally {
      unsubscribe();
    }
  });

  it('ignores expired actors in an already cached snapshot without storage access', () => {
    const snapshot = { '/a': [{ sessionId: 'old', agentId: 'main', updatedAt: Date.now() - 25 * 60 * 60 * 1000 }] };
    const reads = vi.spyOn(localStorage, 'getItem');
    expect(getDistinctActorsForPath('/a', snapshot)).toEqual([]);
    expect(wasTouchedOutsideSession('/a', 'current', snapshot)).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });

  it('uses a supplied fresh snapshot without reading again or mutating it', () => {
    const now = Date.now();
    const prior = { '/a': [{ sessionId: 'other', agentId: 'main', updatedAt: now }] };
    const read = vi.spyOn(localStorage, 'getItem');
    const next = recordFileTouches(['/a'], 'current', new Map([['/a', ['main']]]), now + 1, prior);
    expect(read).not.toHaveBeenCalled();
    expect(prior['/a']).toHaveLength(1);
    expect(next['/a']).toHaveLength(2);
    expect(next).toEqual(JSON.parse(store.get(STORAGE_KEY)!));
  });

  it('evaluates TTL using the supplied recording time', () => {
    const now = Date.now();
    recordFileTouches(['/a'], 'old', new Map(), now);
    const future = now + 25 * 60 * 60 * 1000;
    const next = recordFileTouches(['/a'], 'new', new Map(), future);
    expect(next['/a'].map((actor) => actor.sessionId)).toEqual(['new']);
  });

  it('expires entries older than 24h on read (lazy TTL)', () => {
    const path = '/proj/old.ts';
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), stale);
    // Stale actor is pruned on next load, so a fresh session sees no prior touch
    recordFileTouches([path], 'AI2', new Map([[path, ['main']]]), Date.now());

    expect(isMultiActorPath(path)).toBe(false);
    expect(wasTouchedOutsideSession(path, 'AI2')).toBe(false);
    expect(getDistinctActorsForPath(path).map((a) => a.sessionId)).toEqual(['AI2']);
  });

  it('drops files whose actors all expired and persists the cleanup', () => {
    const path = '/proj/stale-only.ts';
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    recordFileTouches([path], 'AI1', new Map([[path, ['main']]]), stale);

    expect(loadFileTouchMap()).toEqual({});
    expect(store.get(STORAGE_KEY)).toBe('{}');
  });

  it('caps actors per file at 12, keeping the newest', () => {
    const path = '/proj/many-actors.ts';
    const now = Date.now();
    for (let i = 0; i < 13; i += 1) {
      recordFileTouches([path], `sess-${i}`, new Map([[path, ['main']]]), now + i);
    }

    const actors = getDistinctActorsForPath(path);
    expect(actors).toHaveLength(12);
    expect(actors.some((a) => a.sessionId === 'sess-12')).toBe(true);
    expect(actors.some((a) => a.sessionId === 'sess-0')).toBe(false);
  });

  it('caps total files at 400, dropping the oldest', () => {
    const now = Date.now();
    for (let i = 0; i < 405; i += 1) {
      const p = `/proj/f${i}.ts`;
      recordFileTouches([p], 'sess', new Map([[p, ['main']]]), now + i);
    }

    const map = loadFileTouchMap();
    expect(Object.keys(map)).toHaveLength(400);
    expect(map['/proj/f404.ts']).toBeDefined();
    expect(map['/proj/f0.ts']).toBeUndefined();
  });

  it('tolerates corrupted JSON in storage', () => {
    store.set(STORAGE_KEY, 'not-json{');
    expect(loadFileTouchMap()).toEqual({});

    store.set(STORAGE_KEY, '"a string"');
    expect(loadFileTouchMap()).toEqual({});

    store.set(STORAGE_KEY, '[1,2,3]');
    expect(loadFileTouchMap()).toEqual({});
  });
});
