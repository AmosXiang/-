// rubric v1.3 预筛召回审计原型(零 API 成本):评估把 v1.2 的服务端预筛+裁决模式
// 推广到其余三个维度(text_in_frame / 运镜弱项 / graphics_overlay_dependency)的可行性。
// 基准:库内全部成功 replicability 报告(v1.0-v1.2)中各弱项的多数标记(同视频 ≥2 轮)。
// 用法:node scripts/rubric-v13-prescreen-audit.mjs

import Database from 'better-sqlite3';

const VIDEO_IDS = ['1782541753229', '1783073819790', '1783192167990'];

// 候选词表原型(若立项则入库为知识库字段,与 v1.2 的 prescreen 结构一致)。
// 运镜弱项同时扫 movement 与 description 字段;其余扫 description。
const LEXICONS = {
  text_in_frame: {
    fields: ['description'],
    words: ['招牌', '字幕', '文档', '文件', '屏幕', '手机', '电脑', '笔记本', '报纸', '信件', '信封',
      '标题', '文字', '写着', '显示', '海报', '标语', '横幅', '菜单', '合同', '证件', '证书', '钞票',
      '价格', '价签', '短信', '消息', '弹出', '界面', '地图', '定位', '标志', 'logo', '铭牌', '门牌',
      '名片', '图纸', '手表', '警戒线', '清单', '单据', '告示', '看板'],
  },
  camera_motion: {
    fields: ['movement', 'description'],
    words: ['跟拍', '跟随', '追逐', '追踪', '跟踪', '环绕', '绕', '旋转', '急推', '急拉', '推拉',
      '变速', '穿越', '长镜头', '一镜到底', '甩', '手持', '摇摄', '快速移动', '移动跟', '跟着', '尾随'],
    // movement 字段含多段值(逗号/顿号分隔)= 多段机位变化,complex_camera_transition 候选。
    multiSegmentMovement: true,
  },
  graphics_overlay_dependency: {
    fields: ['description'],
    words: ['UI', '界面', '弹窗', '弹出', '特效', '图形', '数据', '表格', '地图', '定位', '全息',
      '投影', '屏幕', '显示', '虚拟', '面板', '菜单', '进度条', '倒计时', '字幕', '标记', '光效',
      '电脑', '笔记本', '名片', '图纸', '文字', '手表', '动画', '片头', '标志', '激光', '光芒', '效果'],
  },
};
// 弱项 → 审计组映射(两个运镜弱项共用一个维度占比,合并审计)。
const WEAKNESS_GROUPS = {
  text_in_frame: 'text_in_frame',
  long_tracking_shot: 'camera_motion',
  complex_camera_transition: 'camera_motion',
  graphics_overlay_dependency: 'graphics_overlay_dependency',
};

const db = new Database('db.sqlite', { readonly: true });
const videos = JSON.parse(db.prepare("SELECT value FROM store WHERE key='videos'").get().value);
const reportRows = db.prepare(
  "SELECT videoId, reportJson FROM shot_analysis_reports WHERE analysisType='replicability' AND status='succeeded' ORDER BY createdAt",
).all();

function parseShotIndex(shotRef, shots) {
  const m = String(shotRef).match(/镜头\s*(\d+)/);
  if (m) return Number(m[1]);
  const t = String(shotRef).match(/(\d{1,2}):(\d{2})/);
  if (t) {
    const seconds = Number(t[1]) * 60 + Number(t[2]);
    const idx = shots.findIndex(s => Math.abs(Number(s.timeSeconds) - seconds) <= 1);
    if (idx >= 0) return idx + 1;
  }
  return null;
}

function shotMatches(shot, lexicon) {
  const haystack = lexicon.fields.map(f => String(shot[f] || '')).join(' ').toLowerCase();
  const matched = lexicon.words.filter(w => haystack.includes(w.toLowerCase()));
  if (lexicon.multiSegmentMovement) {
    const segments = String(shot.movement || '').split(/[,，、;；]/).map(s => s.trim()).filter(Boolean);
    if (segments.length >= 2) matched.push('<多段运镜>');
  }
  return matched;
}

const summary = [];
for (const videoId of VIDEO_IDS) {
  const video = videos.find(v => String(v.id) === videoId);
  const shots = video.analysis.shots;
  const vReports = reportRows.filter(r => r.videoId === videoId);

  for (const [group, lexicon] of Object.entries(LEXICONS)) {
    const groupWeaknesses = Object.entries(WEAKNESS_GROUPS).filter(([, g]) => g === group).map(([w]) => w);
    const markCounts = new Map();
    for (const row of vReports) {
      const report = JSON.parse(row.reportJson);
      const marked = new Set();
      for (const risk of report.shotRisks || []) {
        if (!groupWeaknesses.includes(risk.weaknessId)) continue;
        const idx = parseShotIndex(risk.shotRef, shots);
        if (idx) marked.add(idx);
      }
      for (const idx of marked) markCounts.set(idx, (markCounts.get(idx) || 0) + 1);
    }
    const majority = [...markCounts.entries()].filter(([, n]) => n >= 2).map(([idx]) => idx).sort((a, b) => a - b);

    const candidates = [];
    shots.forEach((shot, i) => {
      if (shotMatches(shot, lexicon).length) candidates.push(i + 1);
    });
    const candidateSet = new Set(candidates);
    const missed = majority.filter(idx => !candidateSet.has(idx));

    summary.push({
      videoId,
      group,
      rounds: vReports.length,
      totalShots: shots.length,
      candidateCount: candidates.length,
      candidateShare: `${(candidates.length / shots.length * 100).toFixed(1)}%`,
      majorityMarked: majority.length,
      recall: majority.length ? `${((majority.length - missed.length) / majority.length * 100).toFixed(1)}%` : 'n/a',
      missed: missed.map(idx => ({
        shotIndex: idx,
        marks: markCounts.get(idx),
        movement: shots[idx - 1].movement,
        description: String(shots[idx - 1].description).slice(0, 70),
      })),
    });
  }
}

for (const row of summary) console.log(JSON.stringify(row, null, row.missed.length ? 2 : 0));
console.log('---');
console.log(JSON.stringify({
  event: 'audit_summary',
  byGroup: Object.keys(LEXICONS).map(group => ({
    group,
    recalls: Object.fromEntries(summary.filter(s => s.group === group).map(s => [s.videoId, s.recall])),
    candidateShares: Object.fromEntries(summary.filter(s => s.group === group).map(s => [s.videoId, s.candidateShare])),
  })),
}, null, 1));
