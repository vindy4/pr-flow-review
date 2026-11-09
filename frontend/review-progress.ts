import type { Analysis } from './types';

type Comparison = Pick<Analysis, 'meta' | 'files'>;
export type ProgressStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;
type ReviewedItem = { id: string; path: string; baseSha: string; headSha: string };
type Decision = Omit<ReviewedItem, 'id'> & { reviewed: boolean; aliases: string[] };
type DecisionEvent = Decision & { order: number; eventId: string };
type Candidate = { item: ReviewedItem; aliases: string[]; decision?: string };
export type ProgressRefreshRequest = { prUrl: string; baseSha: string; headSha: string; reviewed: ReviewedItem[] };
export type ProgressRefreshResponse = {
  baseSha: string; headSha: string;
  reviewed: { id: string; status: 'ready' | 'needs_attention'; path: string; reason: string }[];
};
const STORAGE_ERROR = 'Browser storage is unavailable. Review progress is kept for this session.';
const browserStorage: ProgressStorage = {
  get length() { return localStorage.length; },
  key: index => localStorage.key(index),
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
const shaPattern = /^[a-f0-9]{40}$/i;
function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !/[\\\0\n\r]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function parsed(raw: string | null): unknown {
  try { return JSON.parse(raw || 'null'); } catch { return null; }
}
function pathsFrom(raw: string | null): string[] | null {
  const value = parsed(raw);
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : null;
}
function validDecision(value: unknown): value is Decision {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Decision>;
  return validPath(item.path) && typeof item.baseSha === 'string' && shaPattern.test(item.baseSha)
    && typeof item.headSha === 'string' && shaPattern.test(item.headSha)
    && typeof item.reviewed === 'boolean' && Array.isArray(item.aliases) && item.aliases.every(validPath);
}
function decisionEvent(item: Decision, order: number, eventId: string): DecisionEvent {
  return { path: item.path, baseSha: item.baseSha, headSha: item.headSha, reviewed: item.reviewed,
    aliases: [...new Set([item.path, ...item.aliases])].sort(), order, eventId };
}
function compareEvents(left: DecisionEvent, right: DecisionEvent) {
  return left.order - right.order || (left.eventId > right.eventId ? 1 : left.eventId < right.eventId ? -1 : 0);
}
function decisionVersion(item: DecisionEvent) {
  return JSON.stringify([item.eventId, item.order, item.path, item.baseSha, item.headSha, item.reviewed]);
}
function overlaps(left: Iterable<string>, right: Iterable<string>) {
  const paths = new Set(left);
  return [...right].some(path => paths.has(path));
}

export function reviewIdentity(analysis: Comparison) {
  return `${analysis.meta.repository}:${analysis.meta.number ?? analysis.meta.analysisId ?? 'local'}:${analysis.meta.baseSha}:${analysis.meta.headSha}`;
}

/** Arrays retain legacy progress; explicit decisions supersede older records for their file lineage. */
export function createReviewProgress(analysis: Comparison, storage: ProgressStorage = browserStorage) {
  const { meta } = analysis;
  const key = `flowreview:reviewed:${reviewIdentity(analysis)}`;
  const decisionKey = `flowreview:reviewed-decisions:${meta.repository}:${meta.number}`;
  const decisionPrefix = decisionKey + ':event:';
  const github = meta.mode === 'github' && !!meta.prUrl && meta.number !== null;
  const visiblePaths = new Set(analysis.files.map(file => file.path));
  const touched = new Set<string>();
  let storageError = '';
  function read(storageKey: string) {
    try { return storage.getItem(storageKey); }
    catch { storageError = STORAGE_ERROR; return null; }
  }
  function write(storageKey: string, value: string) {
    try { storage.setItem(storageKey, value); return true; }
    catch { storageError = STORAGE_ERROR; return false; }
  }
  function storedLineage(sourceKey: string): Map<string, string[]> {
    const value = parsed(read(sourceKey + ':lineage'));
    return new Map(value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).filter((entry): entry is [string, string[]] => validPath(entry[0]) && Array.isArray(entry[1]) && entry[1].every(validPath)) : []);
  }
  const lineages = storedLineage(key);
  function aliasesFor(paths: Iterable<string>, decisions: Decision[] = []): string[] {
    const aliases = new Set(paths);
    // Follow all known aliases, including renames persisted by earlier comparisons.
    let previousSize = -1;
    while (previousSize !== aliases.size) {
      previousSize = aliases.size;
      for (const group of [...lineages.values(), ...decisions.map(item => [item.path, ...item.aliases])]) {
        if (overlaps(aliases, group)) for (const path of group) aliases.add(path);
      }
    }
    return [...aliases];
  }
  function rememberLineage(path: string, aliases: Iterable<string>) {
    lineages.set(path, aliasesFor([path, ...aliases]));
  }
  for (const file of analysis.files) rememberLineage(file.path, [file.path, ...(file.previousPath ? [file.previousPath] : [])]);
  let storedRaw = read(key);
  const initial = pathsFrom(storedRaw);
  let initialized = initial !== null;
  let reviewed = new Set(initial || []);
  let generation = 0;
  function persist() {
    const next = JSON.stringify([...reviewed]);
    if (write(key, next)) storedRaw = next;
    if (github) write(key + ':lineage', JSON.stringify(Object.fromEntries(lineages)));
  }
  function currentDecisions(): DecisionEvent[] {
    const legacy = parsed(read(decisionKey));
    const events: DecisionEvent[] = Array.isArray(legacy) ? legacy.flatMap((item, index) => validDecision(item)
      ? [decisionEvent(item, 0, `legacy:${index.toString().padStart(12, '0')}`)] : []) : [];
    try {
      for (let index = 0; index < storage.length; index++) {
        const sourceKey = storage.key(index);
        if (!sourceKey?.startsWith(decisionPrefix)) continue;
        const value = parsed(read(sourceKey));
        if (validDecision(value) && 'order' in value && typeof value.order === 'number'
            && Number.isSafeInteger(value.order) && value.order > 0) {
          events.push(decisionEvent(value, value.order, sourceKey.slice(decisionPrefix.length)));
        }
      }
    } catch { storageError = STORAGE_ERROR; }
    const decisions: DecisionEvent[] = [];
    while (events.length) {
      let winner = events.pop()!;
      const aliases = new Set(aliasesFor([winner.path, ...winner.aliases]));
      let previousSize = -1;
      while (previousSize !== aliases.size) {
        previousSize = aliases.size;
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index];
          const eventAliases = aliasesFor([event.path, ...event.aliases]);
          if (!overlaps(aliases, eventAliases)) continue;
          events.splice(index, 1);
          for (const path of eventAliases) aliases.add(path);
          if (compareEvents(event, winner) > 0) winner = event;
        }
      }
      decisions.push({ ...winner, aliases: [...aliases].sort() });
    }
    return decisions;
  }
  function reconcileInitialized() {
    const decisions = currentDecisions();
    for (const path of visiblePaths) {
      const aliases = aliasesFor([path], decisions);
      const decision = decisions.find(item => overlaps(aliases, [item.path, ...item.aliases]));
      if (!decision) continue;
      if (!decision.reviewed) reviewed.delete(path);
      else if (decision.path === path && decision.baseSha === meta.baseSha && decision.headSha === meta.headSha) reviewed.add(path);
    }
  }
  function recordDecision(path: string) {
    const previous = currentDecisions();
    const aliases = aliasesFor([path], previous);
    // A PR-wide clock preserves chronology if verification later joins unknown rename aliases.
    const order = previous.reduce((latest, item) => Math.max(latest, item.order), 0) + 1;
    // Unique immutable keys prevent interleaved tabs from replacing another file's decision.
    const eventId = crypto.randomUUID();
    write(decisionPrefix + eventId, JSON.stringify({ path, baseSha: meta.baseSha, headSha: meta.headSha,
      reviewed: reviewed.has(path), aliases, order }));
  }
  function olderItems(decisions: DecisionEvent[]): Candidate[] {
    const prefix = `flowreview:reviewed:${meta.repository}:${meta.number}:`;
    const candidates: Candidate[] = [];
    try {
      for (let index = 0; index < storage.length; index++) {
        const sourceKey = storage.key(index);
        if (!sourceKey || sourceKey === key || !sourceKey.startsWith(prefix)) continue;
        const snapshots = /^([a-f0-9]{40}):([a-f0-9]{40})$/i.exec(sourceKey.slice(prefix.length));
        if (!snapshots) continue;
        const sourceLineages = storedLineage(sourceKey);
        for (const path of new Set(pathsFrom(read(sourceKey)) || [])) {
          if (!validPath(path)) continue;
          const aliases = aliasesFor([path, ...(sourceLineages.get(path) || [])], decisions);
          if (decisions.some(item => overlaps(aliases, [item.path, ...item.aliases]))) continue;
          candidates.push({ item: { id: JSON.stringify([sourceKey, path]), path, baseSha: snapshots[1], headSha: snapshots[2] }, aliases });
        }
      }
    } catch { storageError = STORAGE_ERROR; }
    for (const decision of decisions) {
      const { path, baseSha, headSha } = decision;
      candidates.push({ item: { id: decisionPrefix + decision.eventId, path, baseSha, headSha },
        aliases: aliasesFor([path, ...decision.aliases], decisions), decision: decisionVersion(decision) });
    }
    return candidates;
  }
  if (initialized && github) reconcileInitialized();
  return {
    get reviewed() { return new Set(reviewed); },
    get storageError() { return storageError; },
    toggle(path: string) {
      if (!visiblePaths.has(path)) return new Set(reviewed);
      touched.add(path);
      if (reviewed.has(path)) reviewed.delete(path); else reviewed.add(path);
      if (github) recordDecision(path);
      // An explicit empty array is a decision and must survive a subsequent remount.
      persist();
      return new Set(reviewed);
    },
    cancelRefresh() { generation++; },
    async refresh(send: (request: ProgressRefreshRequest) => Promise<ProgressRefreshResponse>): Promise<Set<string> | null> {
      const requestGeneration = ++generation;
      if (initialized) {
        if (github) reconcileInitialized();
        return new Set(reviewed);
      }
      if (!github) return new Set(reviewed);
      const candidates = olderItems(currentDecisions());
      const requested = new Map(candidates.map(candidate => [candidate.item.id, candidate]));
      const results: ProgressRefreshResponse['reviewed'] = [];
      const snapshots = { prUrl: meta.prUrl!, baseSha: meta.baseSha, headSha: meta.headSha };
      // Keep requests below both refresh's item limit and the server's 1 MiB JSON limit.
      const encoder = new TextEncoder();
      for (let offset = 0; offset < candidates.length;) {
        const batch: ReviewedItem[] = [];
        let bytes = encoder.encode(JSON.stringify({ ...snapshots, reviewed: [] })).length;
        while (offset < candidates.length && batch.length < 200) {
          const item = candidates[offset].item;
          const itemBytes = encoder.encode(JSON.stringify(item)).length + 1;
          if (batch.length && bytes + itemBytes >= 900000) break;
          batch.push(item); bytes += itemBytes; offset++;
        }
        const result = await send({ ...snapshots, reviewed: batch });
        if (requestGeneration !== generation) return null;
        // Every batch must validate the displayed target before any progress is persisted.
        if (result.baseSha !== meta.baseSha || result.headSha !== meta.headSha) return null;
        results.push(...result.reviewed);
      }
      if (requestGeneration !== generation) return null;
      const currentRaw = read(key);
      if (currentRaw !== storedRaw) {
        reviewed = new Set(pathsFrom(currentRaw) || []);
        initialized = pathsFrom(currentRaw) !== null;
        storedRaw = currentRaw;
        return new Set(reviewed);
      }
      // Record verified rename relationships before checking all governing decisions.
      for (const item of results) {
        const candidate = requested.get(item.id);
        if (candidate && item.status === 'ready' && visiblePaths.has(item.path)) rememberLineage(item.path, candidate.aliases);
      }
      const latestDecisions = currentDecisions();
      for (const item of results) {
        const candidate = requested.get(item.id);
        if (!candidate || item.status !== 'ready' || !visiblePaths.has(item.path) || touched.has(item.path)) continue;
        const aliases = aliasesFor([item.path, ...candidate.aliases], latestDecisions);
        const decision = latestDecisions.find(record => overlaps(aliases, [record.path, ...record.aliases]));
        if (decision && (!decision.reviewed || candidate.decision !== decisionVersion(decision))) continue;
        reviewed.add(item.path);
      }
      initialized = true;
      // Persist even when no item was eligible, so previous comparisons cannot resurrect it.
      persist();
      return new Set(reviewed);
    },
  };
}
