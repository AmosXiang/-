#!/usr/bin/env node
/**
 * render_pdf.js – Portable per-page PDF renderer for acceptance evidence.
 *
 * Usage:
 *   node render_pdf.js <input.pdf> <output_dir> [page_count]
 *
 * Renders each PDF page independently by navigating to #page=N,
 * producing slide-1.png … slide-N.png at ≥ 240 DPI.
 *
 * No hard-coded paths; all paths come from CLI arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

// ── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node render_pdf.js <input.pdf> <output_dir> [page_count]');
  process.exit(1);
}

const pdfFile = path.resolve(args[0]);
const outDir = path.resolve(args[1]);
const pageCount = parseInt(args[2] || '6', 10);

if (!fs.existsSync(pdfFile)) {
  console.error(`PDF not found: ${pdfFile}`);
  process.exit(1);
}
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// ── Browser discovery ───────────────────────────────────────
const CANDIDATES = process.platform === 'win32'
  ? [
      path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    ]
  : [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];

function findBrowser() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('No supported Chromium-based browser found.');
    process.exit(1);
  }
  console.log('Browser:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const pdfUrl = `file:///${pdfFile.replace(/\\/g, '/')}`;

  for (let pg = 1; pg <= pageCount; pg++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1333, height: 750, deviceScaleFactor: 3 });

    // Navigate directly to the target page — no scrolling needed
    const url = `${pdfUrl}#page=${pg}&toolbar=0&navpanes=0&scrollbar=0`;
    console.log(`Rendering page ${pg}/${pageCount}…`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });

    // Allow the PDF renderer a moment to paint
    await new Promise((r) => setTimeout(r, 2000));

    const outPath = path.join(outDir, `slide-${pg}.png`);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`  → ${outPath}`);

    await page.close();
  }

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
