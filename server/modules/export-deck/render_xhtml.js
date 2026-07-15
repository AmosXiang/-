import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const xhtmlPath = 'file:///C:/Users/Owner/Documents/GitHub/wt-export-package-p4/docs/ui-redesign/tasks/evidence/storyboard-deck.xhtml';
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
    console.error('Could not find Google Chrome or Microsoft Edge installed on standard paths.');
    process.exit(1);
  }

  console.log('Using browser executable:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // Set high resolution viewport (scale factor 3 for >240 DPI equivalent rendering)
  await page.setViewport({
    width: 1333,
    height: 750,
    deviceScaleFactor: 3
  });

  console.log('Navigating to:', xhtmlPath);
  await page.goto(xhtmlPath, { waitUntil: 'networkidle0' });

  // Take screenshot of the page
  console.log('Taking screenshot of the presentation...');
  const outPath = path.join(evidenceDir, 'storyboard-deck-highres.png');
  await page.screenshot({
    path: outPath,
    fullPage: true
  });

  console.log('Screenshot saved to:', outPath);
  await browser.close();
}

run().catch(err => {
  console.error('Error running puppeteer script:', err);
  process.exit(1);
});
