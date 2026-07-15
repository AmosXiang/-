import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore
import PptxGenJS from 'pptxgenjs';
// @ts-ignore
import JSZip from 'jszip';

const PptxGenConstructor = typeof PptxGenJS === 'function' ? PptxGenJS : (PptxGenJS as any).default;
const JSZipConstructor = typeof JSZip === 'function' ? JSZip : (JSZip as any).default;

// Font constraint: Microsoft YaHei
const FONT_FACE = 'Microsoft YaHei';

interface ShotExportData {
  id: string;
  index: number; // 1-based index
  timestamp: string;
  durationSec: number;
  description: string;
  optimizedPrompt: string;
  camera: { move: string; speed: string; note: string };
  framing: { shotSize: string; angle: string };
  cameraH: string | null;
  cameraV: string | null;
  cameraZoom: string | null;
  derivedFromShotId: string | null;
  isMaster: boolean;
  finalized: boolean; // computed valid finalized
  isStale: boolean;
  localImagePath: string | null; // resolved local path if valid and exists
  imageExt: string | null; // image extension e.g. .png
}

/**
 * Checks if a file exists, is actually a file, and has read permissions.
 */
function isReadableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a URL of the format /uploads/... to a local absolute path,
 * checking that it lies within the uploadsDir to prevent directory traversal.
 */
function getLocalPath(url: string | undefined | null, uploadsDir: string): string | null {
  if (!url) return null;
  const cleanUrl = url.startsWith('/') ? url.slice(1) : url;
  if (!cleanUrl.startsWith('uploads/')) {
    return null;
  }
  const relativePart = cleanUrl.slice('uploads/'.length);
  const absoluteUploadsDir = path.resolve(uploadsDir);
  const absolutePath = path.resolve(absoluteUploadsDir, relativePart);

  // Prevent path traversal
  const relative = path.relative(absoluteUploadsDir, absolutePath);
  const isInside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isInside) {
    return null;
  }
  return absolutePath;
}

/**
 * Truncates text and appends "…（全文见 manifest）" if it exceeds maxLength.
 */
function truncateText(text: string | undefined | null, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…（全文见 manifest）';
}

/**
 * Truncates role text and appends "..." if it exceeds maxLength.
 */
function truncateRole(text: string | undefined | null, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

/**
 * Generates the PowerPoint file.
 */
export async function generatePptx(
  script: any,
  mode: 'final' | 'review',
  shotsData: ShotExportData[],
  destPptxPath: string,
  uploadsDir: string
): Promise<void> {
  const pres = new PptxGenConstructor();
  // Using WIDE layout (13.33 x 7.5 inches) to prevent layout overflows
  pres.layout = 'LAYOUT_WIDE';

  // Calculate stats for cover
  const total = shotsData.length;
  const finalized = shotsData.filter(s => s.finalized).length;
  const staleCount = shotsData.filter(s => s.isStale).length;

  // 1. Cover Slide
  const cover = pres.addSlide();
  cover.background = { fill: '121214' }; // dark gray/black background

  // Title
  cover.addText(script.newTitle || '未命名项目', {
    x: 1.0,
    y: 0.8,
    w: 11.33,
    h: 0.8,
    fontFace: FONT_FACE,
    fontSize: 32,
    bold: true,
    color: 'FFFFFF',
  });

  // Topic & Template
  const topicText = `题材/主题：${script.topic || '未设置'} | 模板：${script.templateTitle || '无'}`;
  cover.addText(topicText, {
    x: 1.0,
    y: 1.6,
    w: 11.33,
    h: 0.4,
    fontFace: FONT_FACE,
    fontSize: 12,
    color: '9CA3AF',
  });

  // Narrative elements column layout
  const structureContent = script.newNarrative?.structure || '(未设置)';
  const rhythmContent = script.newNarrative?.rhythm || '(未设置)';
  const climaxContent = script.newNarrative?.climaxDesign || '(未设置)';

  const cols = [
    { title: '结构 (Structure)', content: structureContent, x: 1.0, w: 3.5 },
    { title: '节奏 (Rhythm)', content: rhythmContent, x: 4.8, w: 3.5 },
    { title: '高潮 (Climax Design)', content: climaxContent, x: 8.6, w: 3.7 },
  ];

  for (const col of cols) {
    // Background card for narrative
    cover.addShape(pres.ShapeType.rect, {
      x: col.x,
      y: 2.3,
      w: col.w,
      h: 2.0,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });

    // Column title
    cover.addText(col.title, {
      x: col.x + 0.15,
      y: 2.45,
      w: col.w - 0.3,
      h: 0.3,
      fontFace: FONT_FACE,
      fontSize: 12,
      bold: true,
      color: '3B82F6', // light blue accent
    });

    // Column content (truncated if too long for card)
    cover.addText(truncateText(col.content, 120), {
      x: col.x + 0.15,
      y: 2.8,
      w: col.w - 0.3,
      h: 1.4,
      fontFace: FONT_FACE,
      fontSize: 9.5,
      color: 'D1D5DB',
      valign: 'top',
    });
  }

  // Character table
  const characters = script.newCharacters || [];
  const charY = 4.6;
  const charXStart = 1.0;
  const maxCharsOnCover = 6;

  // Draw header for character table
  if (characters.length > 0) {
    cover.addText('角色表 (Characters)', {
      x: 1.0,
      y: charY - 0.3,
      w: 11.33,
      h: 0.3,
      fontFace: FONT_FACE,
      fontSize: 12,
      bold: true,
      color: '9CA3AF',
    });
  }

  for (let i = 0; i < Math.min(characters.length, maxCharsOnCover); i++) {
    const char = characters[i];
    const cardX = charXStart + i * 1.9;

    // Background card
    cover.addShape(pres.ShapeType.rect, {
      x: cardX,
      y: charY,
      w: 1.8,
      h: 0.9,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });

    // Resolve avatar URL and check validity against uploadsDir strictly checking readability
    const avatarUrl = char.avatarImageUrl || char.avatarUrl || char.avatarGeneration?.imageUrl || null;
    const localAvatarPath = avatarUrl ? getLocalPath(avatarUrl, uploadsDir) : null;
    const avatarExists = localAvatarPath ? isReadableFile(localAvatarPath) : false;

    if (localAvatarPath && avatarExists) {
      cover.addImage({
        path: localAvatarPath,
        x: cardX + 0.08,
        y: charY + 0.08,
        w: 0.74,
        h: 0.74,
        sizing: { type: 'contain', w: 0.74, h: 0.74 },
      });
    } else {
      // Text avatar placeholder
      const placeholderText = char.name ? char.name[0] : 'C';
      cover.addShape(pres.ShapeType.rect, {
        x: cardX + 0.08,
        y: charY + 0.08,
        w: 0.74,
        h: 0.74,
        fill: { color: '2D2D30' },
        line: { color: '4B5563', width: 1 },
      });
      cover.addText(placeholderText, {
        x: cardX + 0.08,
        y: charY + 0.08,
        w: 0.74,
        h: 0.74,
        fontFace: FONT_FACE,
        fontSize: 14,
        bold: true,
        color: '9CA3AF',
        align: 'center',
        valign: 'middle',
      });
    }

    // Name
    cover.addText(char.name || '未命名', {
      x: cardX + 0.9,
      y: charY + 0.1,
      w: 0.85,
      h: 0.35,
      fontFace: FONT_FACE,
      fontSize: 10,
      bold: true,
      color: 'FFFFFF',
      valign: 'top',
    });

    // Role
    cover.addText(truncateRole(char.role, 14), {
      x: cardX + 0.9,
      y: charY + 0.45,
      w: 0.82,
      h: 0.38,
      fontFace: FONT_FACE,
      fontSize: 7.5,
      color: '9CA3AF',
      valign: 'top',
      shrinkText: true,
    });
  }

  // Cover Footer
  if (mode === 'review') {
    cover.addText(`审阅稿 · 已定稿 ${finalized}/${total}`, {
      x: 1.0,
      y: 6.8,
      w: 5.0,
      h: 0.4,
      fontFace: FONT_FACE,
      fontSize: 12,
      bold: true,
      color: 'F59E0B', // Amber
    });
  } else {
    cover.addText(`正式交付包 (定稿 ${finalized}/${total})`, {
      x: 1.0,
      y: 6.8,
      w: 5.0,
      h: 0.4,
      fontFace: FONT_FACE,
      fontSize: 12,
      bold: true,
      color: '10B981', // Green
    });
  }

  if (staleCount > 0) {
    cover.addText(`⚠ ${staleCount} 镜基于旧输入`, {
      x: 6.5,
      y: 6.8,
      w: 5.0,
      h: 0.4,
      fontFace: FONT_FACE,
      fontSize: 12,
      bold: true,
      color: 'EF4444', // Red
    });
  }

  // 2. Shot Slides
  for (const shot of shotsData) {
    const slide = pres.addSlide();
    slide.background = { fill: '121214' };

    // Header info
    slide.addText(`#${shot.index}  ${shot.timestamp || '00:00'} (${shot.durationSec}s)`, {
      x: 0.5,
      y: 0.4,
      w: 8.0,
      h: 0.6,
      fontFace: FONT_FACE,
      fontSize: 22,
      bold: true,
      color: 'FFFFFF',
    });

    // DRAFT Badge for unfinalized slides in review mode
    if (!shot.finalized) {
      slide.addShape(pres.ShapeType.rect, {
        x: 11.5,
        y: 0.4,
        w: 1.33,
        h: 0.4,
        fill: { color: 'EF4444' }, // Red
      });
      slide.addText('DRAFT', {
        x: 11.5,
        y: 0.4,
        w: 1.33,
        h: 0.4,
        fontFace: FONT_FACE,
        fontSize: 12,
        bold: true,
        color: 'FFFFFF',
        align: 'center',
        valign: 'middle',
        margin: 0,
        wrap: false,
      });
    }

    // Main Image Box
    const imgX = 0.5;
    const imgY = 1.2;
    const imgW = 6.8;
    const imgH = 4.5;

    // Dark background for contain ratio fill
    slide.addShape(pres.ShapeType.rect, {
      x: imgX,
      y: imgY,
      w: imgW,
      h: imgH,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });

    if (shot.localImagePath) {
      slide.addImage({
        path: shot.localImagePath,
        x: imgX,
        y: imgY,
        w: imgW,
        h: imgH,
        sizing: { type: 'contain', w: imgW, h: imgH },
      });
    } else {
      slide.addText('未生成图片', {
        x: imgX,
        y: imgY + 2.0,
        w: imgW,
        h: 0.5,
        fontFace: FONT_FACE,
        fontSize: 18,
        color: '6B7280',
        align: 'center',
      });
    }

    // Parameters Grid Card layout
    const gridX = 7.6;
    const gridW = 5.2;
    const rowH = 0.45;
    const rowGap = 0.1;

    // Row 1: Camera Move & Speed & Note
    const moveSpeedText = `运镜: ${shot.camera.move || 'static'} (${shot.camera.speed || 'medium'})${
      shot.camera.note ? ` | ${shot.camera.note}` : ''
    }`;
    slide.addShape(pres.ShapeType.rect, {
      x: gridX,
      y: 1.2,
      w: gridW,
      h: rowH,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });
    slide.addText(truncateText(moveSpeedText, 70), {
      x: gridX + 0.15,
      y: 1.2,
      w: gridW - 0.3,
      h: rowH,
      fontFace: FONT_FACE,
      fontSize: 10,
      color: 'E5E7EB',
      valign: 'middle',
    });

    // Row 2: Framing
    const framingText = `景别: ${shot.framing.shotSize || 'medium'} | 视角: ${shot.framing.angle || 'front'}`;
    slide.addShape(pres.ShapeType.rect, {
      x: gridX,
      y: 1.2 + (rowH + rowGap),
      w: gridW,
      h: rowH,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });
    slide.addText(framingText, {
      x: gridX + 0.15,
      y: 1.2 + (rowH + rowGap),
      w: gridW - 0.3,
      h: rowH,
      fontFace: FONT_FACE,
      fontSize: 10,
      color: 'E5E7EB',
      valign: 'middle',
    });

    // Row 3: H/V/Zoom Position
    const posText = `机位: H:${shot.cameraH || '-'} | V:${shot.cameraV || '-'} | Zoom:${shot.cameraZoom || '-'}`;
    slide.addShape(pres.ShapeType.rect, {
      x: gridX,
      y: 1.2 + 2 * (rowH + rowGap),
      w: gridW,
      h: rowH,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });
    slide.addText(posText, {
      x: gridX + 0.15,
      y: 1.2 + 2 * (rowH + rowGap),
      w: gridW - 0.3,
      h: rowH,
      fontFace: FONT_FACE,
      fontSize: 10,
      color: 'E5E7EB',
      valign: 'middle',
    });

    // Row 4: Derived / Master / Normal Type
    let typeText = '分镜类型: 普通分镜';
    let typeColor = 'E5E7EB';
    if (shot.isMaster) {
      typeText = '分镜类型: ★ 主帧';
      typeColor = 'F59E0B'; // Gold/Amber
    } else if (shot.derivedFromShotId) {
      const parentShot = shotsData.find(s => String(s.id) === String(shot.derivedFromShotId));
      const parentIdx = parentShot ? parentShot.index : '?';
      typeText = `分镜类型: 派生自 #${parentIdx}`;
      typeColor = '60A5FA'; // Light Blue
    }

    slide.addShape(pres.ShapeType.rect, {
      x: gridX,
      y: 1.2 + 3 * (rowH + rowGap),
      w: gridW,
      h: rowH,
      fill: { color: '1A1A1E' },
      line: { color: '2E2E34', width: 1 },
    });
    slide.addText(typeText, {
      x: gridX + 0.15,
      y: 1.2 + 3 * (rowH + rowGap),
      w: gridW - 0.3,
      h: rowH,
      fontFace: FONT_FACE,
      fontSize: 10,
      bold: shot.isMaster || !!shot.derivedFromShotId,
      color: typeColor,
      valign: 'middle',
    });

    // Description Section
    slide.addText('情节描述 (Description)', {
      x: gridX,
      y: 3.8,
      w: gridW,
      h: 0.25,
      fontFace: FONT_FACE,
      fontSize: 11,
      bold: true,
      color: '3B82F6',
    });
    slide.addText(truncateText(shot.description, 140), {
      x: gridX,
      y: 4.15,
      w: gridW,
      h: 1.1,
      fontFace: FONT_FACE,
      fontSize: 10.5,
      color: 'D1D5DB',
      valign: 'top',
    });

    // Prompt Section
    slide.addText('提示词 (Optimized Prompt)', {
      x: gridX,
      y: 5.3,
      w: gridW,
      h: 0.25,
      fontFace: FONT_FACE,
      fontSize: 11,
      bold: true,
      color: '10B981',
    });
    slide.addText(truncateText(shot.optimizedPrompt, 180), {
      x: gridX,
      y: 5.65,
      w: gridW,
      h: 1.1,
      fontFace: FONT_FACE,
      fontSize: 9.5,
      italic: true,
      color: '9CA3AF',
      valign: 'top',
    });

    // Page footer warning if stale
    if (shot.isStale) {
      slide.addText('⚠ 基于旧版剧本生成', {
        x: 0.5,
        y: 6.8,
        w: 12.33,
        h: 0.4,
        fontFace: FONT_FACE,
        fontSize: 10,
        bold: true,
        color: 'EF4444',
      });
    }
  }

  // 3. Contact Sheet Summary Slide(s)
  const shotsPerPage = 16;
  const numPages = Math.ceil(total / shotsPerPage);

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const csSlide = pres.addSlide();
    csSlide.background = { fill: '121214' };

    // Slide Title
    csSlide.addText(`镜头总览 (Contact Sheet) - 第 ${pageIdx + 1}/${numPages} 页`, {
      x: 0.5,
      y: 0.4,
      w: 12.33,
      h: 0.4,
      fontFace: FONT_FACE,
      fontSize: 18,
      bold: true,
      color: 'FFFFFF',
    });

    const startIdx = pageIdx * shotsPerPage;
    const endIdx = Math.min(startIdx + shotsPerPage, total);

    for (let i = startIdx; i < endIdx; i++) {
      const shot = shotsData[i];
      const relativeIdx = i - startIdx;
      const row = Math.floor(relativeIdx / 4);
      const col = relativeIdx % 4;

      const x = 0.76 + col * 3.0;
      const y = 1.1 + row * 1.4;

      // Draw slot background card
      csSlide.addShape(pres.ShapeType.rect, {
        x,
        y,
        w: 2.8,
        h: 1.2,
        fill: { color: '1A1A1E' },
        line: { color: '2E2E34', width: 1 },
      });

      // Image or placeholder
      const imgX = x + 0.1;
      const imgY = y + 0.15;
      const imgW = 1.6;
      const imgH = 0.9; // 16:9 ratio fits nicely in 1.2 height leaving 0.15 margins

      if (shot.localImagePath) {
        csSlide.addImage({
          path: shot.localImagePath,
          x: imgX,
          y: imgY,
          w: imgW,
          h: imgH,
          sizing: { type: 'contain', w: imgW, h: imgH },
        });
      } else {
        csSlide.addShape(pres.ShapeType.rect, {
          x: imgX,
          y: imgY,
          w: imgW,
          h: imgH,
          fill: { color: '2D2D30' },
          line: { color: '4B5563', width: 1 },
        });
        csSlide.addText('无图', {
          x: imgX,
          y: imgY,
          w: imgW,
          h: imgH,
          fontFace: FONT_FACE,
          fontSize: 10,
          color: '6B7280',
          align: 'center',
          valign: 'middle',
        });
      }

      // Add Corner Badges: DRAFT (unfinalized) or N/A (no image)
      const isDraft = !shot.finalized;
      const isNoImage = !shot.localImagePath;

      if (isDraft || isNoImage) {
        const badgeW = 0.45;
        const badgeH = 0.22;
        const badgeX = imgX + imgW - badgeW;
        const badgeY = imgY;

        csSlide.addShape(pres.ShapeType.rect, {
          x: badgeX,
          y: badgeY,
          w: badgeW,
          h: badgeH,
          fill: { color: 'EF4444' }, // Red
        });
        // Disabling wrapping and setting margins to 0 ensures "DRAFT" never gets wrapped as "DRA FT"
        csSlide.addText(isDraft ? 'DRAFT' : 'N/A', {
          x: badgeX,
          y: badgeY,
          w: badgeW,
          h: badgeH,
          fontFace: FONT_FACE,
          fontSize: 7.5,
          bold: true,
          color: 'FFFFFF',
          align: 'center',
          valign: 'middle',
          margin: 0,
          wrap: false,
        });
      }

      // Metadata text on the right side of the image
      const textX = x + 1.75;
      const textW = 0.95;

      // 1. #序号
      const twoDigitIdx = String(shot.index).padStart(2, '0');
      csSlide.addText(`#${twoDigitIdx}`, {
        x: textX,
        y: y + 0.15,
        w: textW,
        h: 0.25,
        fontFace: FONT_FACE,
        fontSize: 11,
        bold: true,
        color: 'FFFFFF',
      });

      // 2. Shot size & Framing (small size)
      const sizeText = shot.framing.shotSize || '-';
      csSlide.addText(sizeText, {
        x: textX,
        y: y + 0.45,
        w: textW,
        h: 0.2,
        fontFace: FONT_FACE,
        fontSize: 8,
        color: '9CA3AF',
      });

      // 3. Duration & master status
      const durationText = `${shot.durationSec}s${shot.isMaster ? ' ★' : ''}`;
      csSlide.addText(durationText, {
        x: textX,
        y: y + 0.75,
        w: textW,
        h: 0.25,
        fontFace: FONT_FACE,
        bold: shot.isMaster,
        fontSize: 8.5,
        color: shot.isMaster ? 'F59E0B' : '9CA3AF',
      });
    }

    // Footers
    csSlide.addText(`审阅稿 · 镜头总览页面`, {
      x: 0.5,
      y: 6.9,
      w: 5.0,
      h: 0.3,
      fontFace: FONT_FACE,
      fontSize: 10,
      color: '9CA3AF',
    });
  }

  // Save the slide deck file
  await pres.writeFile({ fileName: destPptxPath });
}

/**
 * Generates the manifest.json file content.
 */
export function generateManifest(
  script: any,
  mode: 'final' | 'review',
  shotsData: ShotExportData[],
  exportRelDir: string,
  uploadsDir: string
): string {
  const manifest = {
    manifestVersion: 1,
    projectId: String(script.id),
    title: script.newTitle || '',
    exportedAt: new Date().toISOString(),
    mode,
    narrative: {
      structure: script.newNarrative?.structure || '',
      rhythm: script.newNarrative?.rhythm || '',
      climaxDesign: script.newNarrative?.climaxDesign || '',
    },
    characters: (script.newCharacters || []).map((char: any) => {
      const avatarUrl = char.avatarImageUrl || char.avatarUrl || char.avatarGeneration?.imageUrl || null;
      const localAvatarPath = avatarUrl ? getLocalPath(avatarUrl, uploadsDir) : null;
      const avatarExists = localAvatarPath ? isReadableFile(localAvatarPath) : false;
      return {
        id: String(char.id),
        name: char.name || '',
        role: char.role || '',
        avatarUrl: avatarExists ? avatarUrl : null,
      };
    }),
    shots: shotsData.map(shot => ({
      id: shot.id,
      index: shot.index,
      timestamp: shot.timestamp,
      durationSec: shot.durationSec,
      description: shot.description,
      optimizedPrompt: shot.optimizedPrompt,
      camera: shot.camera,
      framing: shot.framing,
      cameraH: shot.cameraH,
      cameraV: shot.cameraV,
      cameraZoom: shot.cameraZoom,
      derivedFromShotId: shot.derivedFromShotId,
      isMaster: shot.isMaster,
      finalized: shot.finalized,
      isStale: shot.isStale,
      imageFile: shot.localImagePath ? `finals/shot-${String(shot.index).padStart(2, '0')}${shot.imageExt}` : null,
    })),
  };

  return JSON.stringify(manifest, null, 2);
}

/**
 * Creates the zip deliverable archive containing the entire exportDir structure.
 */
export async function createExportZip(
  exportDir: string,
  destZipPath: string
): Promise<void> {
  const zip = new JSZipConstructor();
  const zipFileName = path.basename(destZipPath);

  function addDirRecursively(localDir: string, zipFolder: any) {
    const entries = fs.readdirSync(localDir);
    for (const entry of entries) {
      const fullPath = path.join(localDir, entry);
      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        const subFolder = zipFolder.folder(entry)!;
        addDirRecursively(fullPath, subFolder);
      } else {
        if (entry !== zipFileName) {
          zipFolder.file(entry, fs.readFileSync(fullPath));
        }
      }
    }
  }

  addDirRecursively(exportDir, zip);

  // Generate buffer and write to file
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(destZipPath, buffer);
}
