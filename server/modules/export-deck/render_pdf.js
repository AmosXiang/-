import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const pdfPath = 'file:///C:/Users/Owner/Documents/GitHub/wt-export-package-p4/docs/ui-redesign/tasks/evidence/storyboard-deck.pdf#toolbar=0&navpanes=0&scrollbar=0';
const evidenceDir = 'C:\\Users\\Owner\\Documents\\GitHub\\wt-export-package-p4\\docs\\ui-redesign\\tasks\\evidence';

async function run() {
  let executablePath = '';
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) {
      executablePath = p;
      break;
    }
  }

  if (!executablePath) {
    console.error('Could not find Google Chrome or Microsoft Edge.');
    process.exit(1);
  }

  console.log('Using browser:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1333,750'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({
    width: 1333,
    height: 750,
    deviceScaleFactor: 3 // high DPI > 240
  });

  console.log('Navigating to PDF:', pdfPath);
  await page.goto(pdfPath);
  
  // Wait for the PDF to load inside Chrome
  console.log('Waiting for PDF viewer to render...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Focus the PDF viewer plug-in
  console.log('Focusing PDF viewer...');
  await page.mouse.click(600, 300);
  await new Promise(resolve => setTimeout(resolve, 500));

  // Loop through all 6 pages (Cover + 4 shots + 1 Contact Sheet)
  for (let pageNum = 1; pageNum <= 6; pageNum++) {
    const outPath = path.join(evidenceDir, `slide-${pageNum}.png`);
    await page.screenshot({
      path: outPath,
      fullPage: false
    });
    console.log(`Page ${pageNum} screenshot saved to:`, outPath);

    if (pageNum < 6) {
      // Press PageDown to scroll down by exactly one page viewport
      await page.keyboard.press('PageDown');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  await browser.close();
  console.log('PDF paging conversion finished successfully.');
}

run().catch(err => {
  console.error('Error running puppeteer PDF paging script:', err);
  process.exit(1);
});
