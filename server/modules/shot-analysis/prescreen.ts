// 服务端确定性预筛(rubric v1.2):multi_character_interaction 的候选镜头筛选。
// 纯字符串/正则,零模型调用。设计与召回审计见 docs/shot-analysis/RUBRIC-V1.2-DESIGN.md。
// 原则:候选集是封闭域(裁决调用禁止提名候选外镜头),因此宁可多选交给裁决过滤,
// 不可漏选——三类信号取并集,复数/互动线索单独命中即入候选。

export type PrescreenLexicons = {
  roleFunctionWords: string[];
  pluralInteractionCues: string[];
};

export type PrescreenShot = {
  timestamp: string;
  description: string;
  movement?: string;
};

export type ShotCandidate = {
  shotIndex: number; // 1-based,与报告中"镜头N"一致
  timestamp: string;
  description: string;
  referents: string[]; // 命中的独立人物指称(已合并、已按角色去重)
  cues: string[]; // 命中的复数/互动线索
};

export type PrescreenResult = {
  totalShots: number;
  candidates: ShotCandidate[];
  aliases: string[];
};

// 注册别名归一化:按 "/" 拆分("路人甲 / 胖子"→两个别名),按括号拆分("梅 (Mei)"→"梅"+"Mei"),
// 去除长度 <2 的碎片。返回 [别名, 角色key] 对——同一角色的多个别名共享 key,用于指称去重。
export function extractAliases(characters: Array<{ name: string }>): Array<{ alias: string; characterKey: string }> {
  const out: Array<{ alias: string; characterKey: string }> = [];
  const seen = new Set<string>();
  characters.forEach((c, idx) => {
    const characterKey = `char:${idx}`;
    const pieces: string[] = [];
    for (const slashPart of String(c.name || '').split('/')) {
      // 括号拆分:括号外主体 + 括号内内容各为一个别名(全角/半角括号都处理)。
      const inParens = [...slashPart.matchAll(/[(（]([^)）]+)[)）]/g)].map(m => m[1]);
      const outsideParens = slashPart.replace(/[(（][^)）]*[)）]/g, ' ');
      pieces.push(outsideParens, ...inParens);
    }
    for (const piece of pieces) {
      const alias = piece.trim();
      if (alias.length < 2) continue;
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ alias, characterKey });
    }
  });
  return out;
}

type Span = { start: number; end: number; referentKey: string; text: string };

// 在 description 中找出一组词的全部出现位置。拉丁别名忽略大小写。
function findSpans(description: string, word: string, referentKey: string): Span[] {
  const spans: Span[] = [];
  const haystack = description.toLowerCase();
  const needle = word.toLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    spans.push({ start: at, end: at + needle.length, referentKey, text: description.slice(at, at + needle.length) });
    from = at + 1;
  }
  return spans;
}

// 跨度合并:仅在重叠或紧邻(gap=0)时合并为一个指称("黑人男性士兵"=1 人)。
// 审计验证过 gap≤2 会把"郑吒转向詹岚"误并成 1 人,禁止放宽。
function mergeSpans(spans: Span[]): Array<{ referentKeys: Set<string>; text: string }> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; referentKeys: Set<string>; texts: string[] }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.referentKeys.add(span.referentKey);
      last.texts.push(span.text);
    } else {
      merged.push({ start: span.start, end: span.end, referentKeys: new Set([span.referentKey]), texts: [span.text] });
    }
  }
  return merged.map(m => ({ referentKeys: m.referentKeys, text: m.texts.join('+') }));
}

// 单镜头指称统计:合并后的跨度按指称身份去重(同一角色/同一功能词的多次出现只算 1 人;
// 合并跨度含注册角色时以角色 key 为身份,纯功能词跨度以合并文本为身份)。
export function countReferents(description: string, aliases: Array<{ alias: string; characterKey: string }>, roleFunctionWords: string[]): string[] {
  const spans: Span[] = [];
  for (const { alias, characterKey } of aliases) spans.push(...findSpans(description, alias, characterKey));
  for (const word of roleFunctionWords) spans.push(...findSpans(description, word, `role:${word}`));
  const identities = new Map<string, string>();
  for (const m of mergeSpans(spans)) {
    // 优先取角色 key(注册角色身份唯一);纯功能词跨度以合并文本为身份键。
    const charKey = [...m.referentKeys].find(k => k.startsWith('char:'));
    const key = charKey || `role:${m.text.toLowerCase()}`;
    if (!identities.has(key)) identities.set(key, m.text);
  }
  return [...identities.values()];
}

export function prescreenMultiCharacterShots(
  shots: PrescreenShot[],
  characters: Array<{ name: string }>,
  lexicons: PrescreenLexicons,
): PrescreenResult {
  const aliases = extractAliases(characters);
  const candidates: ShotCandidate[] = [];
  shots.forEach((shot, i) => {
    const description = String(shot.description || '');
    const referents = countReferents(description, aliases, lexicons.roleFunctionWords);
    const cues = lexicons.pluralInteractionCues.filter(cue => description.includes(cue));
    if (referents.length >= 2 || cues.length > 0) {
      candidates.push({ shotIndex: i + 1, timestamp: String(shot.timestamp || ''), description, referents, cues });
    }
  });
  return { totalShots: shots.length, candidates, aliases: aliases.map(a => a.alias) };
}

// v1.3 通用词表预筛:词表命中指定字段即入候选(宁多勿漏,裁决过滤);
// multiSegmentMovement 时 movement 字段含 ≥2 个分隔段(逗号/顿号)也入候选(多段机位变化信号)。
export function prescreenLexiconShots(
  shots: PrescreenShot[],
  config: { fields?: string[]; words?: string[]; multiSegmentMovement?: boolean },
): PrescreenResult {
  const fields = config.fields?.length ? config.fields : ['description'];
  const words = config.words || [];
  const candidates: ShotCandidate[] = [];
  shots.forEach((shot, i) => {
    const haystack = fields.map(f => String((shot as any)[f] || '')).join(' ').toLowerCase();
    const matched = words.filter(w => haystack.includes(w.toLowerCase()));
    if (config.multiSegmentMovement) {
      const segments = String(shot.movement || '').split(/[,，、;；]/).map(s => s.trim()).filter(Boolean);
      if (segments.length >= 2) matched.push('<多段运镜>');
    }
    if (matched.length > 0) {
      candidates.push({ shotIndex: i + 1, timestamp: String(shot.timestamp || ''), description: String(shot.description || ''), referents: [], cues: matched });
    }
  });
  return { totalShots: shots.length, candidates, aliases: [] };
}

// pulid_latency 聚合统计(v1.2 第 4 节):身份锁定镜头 = description 含 ≥1 个注册角色别名。
// 纯字符串判定,不涉及模型。
export function countIdentityLockedShots(shots: PrescreenShot[], characters: Array<{ name: string }>): number {
  const aliases = extractAliases(characters);
  let count = 0;
  for (const shot of shots) {
    const description = String(shot.description || '');
    if (aliases.some(({ alias }) => description.toLowerCase().includes(alias.toLowerCase()))) count += 1;
  }
  return count;
}

export type AnchorThresholds = { t8: number; t5: number };

// 占比 → 锚点分映射。区间边界严格按知识库 anchors 的 ≤/< 记号,阈值按维度
// anchorThresholds 驱动(v1.3:still/post 为 0.10/0.30,identity/camera 为 0.10/0.25):
// 0% → 10;0 < r ≤ t8 → 8;t8 < r ≤ t5 → 5;r > t5 → 2。
export function ratioToAnchorScore(ratio: number, thresholds: AnchorThresholds): 2 | 5 | 8 | 10 {
  if (ratio <= 0) return 10;
  if (ratio <= thresholds.t8) return 8;
  if (ratio <= thresholds.t5) return 5;
  return 2;
}

// 距区间边界的镜头数披露(v1.2 第 3 节:不做迟滞,只做披露)。
// 返回当前占比距最近锚点边界还差几个 hit(向上跨带所需的最小新增命中数;已在 2 分档时为 null)。
export function hitsToNextBand(hits: number, totalShots: number, thresholds: AnchorThresholds): number | null {
  if (totalShots <= 0) return null;
  const boundaries = [0, thresholds.t8, thresholds.t5];
  const ratio = hits / totalShots;
  for (const b of boundaries) {
    if (ratio <= b) {
      // 跨过边界 b 需要 hits' / total > b,即 hits' = floor(b * total) + 1
      const needed = Math.floor(b * totalShots) + 1 - hits;
      return Math.max(needed, 1);
    }
  }
  return null; // 已在最低档(>t5),不存在再向下跨带
}
