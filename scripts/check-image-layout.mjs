import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});

const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});

const previewUrl = process.env.COLOR_TOY_PREVIEW_URL || 'http://127.0.0.1:4174/';
await page.goto(previewUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(250);

const tempImagePath = path.resolve('scripts/.verification-test-image.svg');
const tempImageSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a6d4ff"/>
      <stop offset="55%" stop-color="#748aa4"/>
      <stop offset="100%" stop-color="#2b3240"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#2f3d2f"/>
      <stop offset="100%" stop-color="#182017"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="#090b0f"/>
  <rect x="0" y="80" width="1600" height="820" fill="url(#sky)"/>
  <path d="M0 620 C 280 520, 360 720, 680 610 S 1120 520, 1600 660 L 1600 900 L 0 900 Z" fill="url(#ground)"/>
  <rect x="110" y="250" width="250" height="520" fill="#e8eef5"/>
  <rect x="150" y="300" width="65" height="80" fill="#1a2230"/>
  <rect x="250" y="300" width="65" height="80" fill="#1a2230"/>
  <rect x="150" y="420" width="65" height="80" fill="#1a2230"/>
  <rect x="250" y="420" width="65" height="80" fill="#1a2230"/>
  <rect x="150" y="540" width="65" height="80" fill="#1a2230"/>
  <rect x="250" y="540" width="65" height="80" fill="#1a2230"/>
  <rect x="1200" y="590" width="210" height="70" fill="#b21f2d"/>
  <rect x="1410" y="590" width="34" height="240" fill="#e6d3b7"/>
  <rect x="1080" y="590" width="330" height="18" fill="#f1e7db"/>
  <path d="M980 900 C 1060 760, 1190 760, 1380 900 Z" fill="#1f3620"/>
  <path d="M1180 560 C 1230 490, 1330 520, 1380 600" fill="none" stroke="#d9e6d4" stroke-width="18" stroke-linecap="round"/>
  <circle cx="390" cy="210" r="110" fill="#ffffff" fill-opacity="0.14"/>
</svg>`;
fs.writeFileSync(tempImagePath, tempImageSvg);
await page.setInputFiles('#image-input', tempImagePath);
await page.waitForTimeout(700);

const initial = await page.evaluate(() => ({
  layout: document.documentElement.getAttribute('data-ui-layout'),
  width: window.innerWidth,
  height: window.innerHeight,
  mobileBar: getComputedStyle(document.getElementById('mobile-module-bar')).display,
  header: getComputedStyle(document.getElementById('header')).display,
  topControlBar: getComputedStyle(document.getElementById('top-control-bar')).display,
  previewControlsDivider: (() => {
    const element = document.getElementById('preview-controls-divider');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      display: style.display,
      position: style.position,
      y: rect.y,
      h: rect.height,
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    };
  })(),
}));

await page.locator('.mobile-module-btn[data-mobile-module="calibration"]').click({ force: true });
await page.waitForTimeout(400);

const calibrationRed = await page.evaluate(() => {
  const selectors = ['#calibration-primary-tabs', '#isolated-cal-sliders', '#xy-panel'];
  return Object.fromEntries(selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [selector, null];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [selector, {
      display: style.display,
      position: style.position,
      bottom: style.bottom,
      top: style.top,
      y: rect.y,
      h: rect.height,
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }];
  }));
});

const calibrationChrome = await page.evaluate(() => ({
  header: getComputedStyle(document.getElementById('header')).display,
  topControlBar: getComputedStyle(document.getElementById('top-control-bar')).display,
  undoParent: document.getElementById('undo-btn')?.parentElement?.id ?? null,
  redoParent: document.getElementById('redo-btn')?.parentElement?.id ?? null,
}));

await page.locator('#calibration-primary-tabs [data-cal-primary="xy"]').click({ force: true });
await page.waitForTimeout(400);

const calibrationXY = await page.evaluate(() => {
  const selectors = ['#calibration-primary-tabs', '#isolated-cal-sliders', '#xy-panel'];
  return Object.fromEntries(selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [selector, null];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [selector, {
      display: style.display,
      position: style.position,
      bottom: style.bottom,
      top: style.top,
      y: rect.y,
      h: rect.height,
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }];
  }));
});

const calibrationDivider = await page.evaluate(() => {
  const element = document.getElementById('preview-controls-divider');
  if (!element) return null;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    display: style.display,
    y: rect.y,
    h: rect.height,
    text: element.textContent?.replace(/\s+/g, ' ').trim(),
  };
});

await page.screenshot({ path: 'screenshots/image-layout-calibration-xy.png' });

await page.locator('.mobile-module-btn[data-mobile-module="wheels"]').click({ force: true });
await page.waitForTimeout(400);

const wheelsOpen = await page.evaluate(() => {
  const selectors = ['#wheels-panel', '#wheels-dock-btn', '#wheels-row', '#xy-panel', '#calibration-panel', '#preview-controls-divider'];
  const snapshot = Object.fromEntries(selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [selector, null];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [selector, {
      display: style.display,
      position: style.position,
      y: rect.y,
      h: rect.height,
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }];
  }));

  const dock = document.getElementById('wheels-dock-btn');
  const row = document.getElementById('wheels-row');
  return {
    ...snapshot,
    dockMode: {
      modeIn: !!dock?.classList.contains('mode-in'),
      modeOut: !!dock?.classList.contains('mode-out'),
      hasSvgIcon: !!dock?.querySelector('svg'),
    },
    compareMode: {
      inside: !!row?.classList.contains('wheels-compare-inside'),
      swap: !!row?.classList.contains('wheels-compare-swap'),
    },
  };
});

await page.screenshot({ path: 'screenshots/image-layout-wheels-open.png' });

await page.locator('#wheels-dock-btn').click({ force: true });
await page.waitForTimeout(350);

const wheelsCollapsed = await page.evaluate(() => {
  const selectors = ['#wheels-panel', '#wheels-row', '#wheels-dock-btn', '#preview-controls-divider'];
  const snapshot = Object.fromEntries(selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [selector, null];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [selector, {
      display: style.display,
      position: style.position,
      y: rect.y,
      h: rect.height,
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }];
  }));

  const dock = document.getElementById('wheels-dock-btn');
  return {
    ...snapshot,
    dockMode: {
      modeIn: !!dock?.classList.contains('mode-in'),
      modeOut: !!dock?.classList.contains('mode-out'),
      hasSvgIcon: !!dock?.querySelector('svg'),
    },
  };
});

await page.screenshot({ path: 'screenshots/image-layout-wheels-collapsed.png' });

await page.locator('.mobile-module-btn[data-mobile-module="toning"]').click({ force: true });
await page.waitForTimeout(400);

const toningContrast = await page.evaluate(() => {
  const panel = document.getElementById('toning-panel');
  const isolated = document.getElementById('isolated-controls-sliders');
  const visibleRowsInPanel = Array.from(document.querySelectorAll('#toning-panel .toning-slider-row')).filter((row) => {
    const style = getComputedStyle(row);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).length;
  const visibleRowsInOverlay = Array.from(document.querySelectorAll('#isolated-controls-sliders .toning-slider-row')).filter((row) => {
    const style = getComputedStyle(row);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).length;

  return {
    panelDisplay: panel ? getComputedStyle(panel).display : null,
    overlayDisplay: isolated ? getComputedStyle(isolated).display : null,
    visibleRowsInPanel,
    visibleRowsInOverlay,
  };
});

await page.screenshot({ path: 'screenshots/image-layout-toning-contrast.png' });

await page.locator('#toning-control-tabs [data-toning-control="curve"]').click({ force: true });
await page.waitForTimeout(500);
await page.locator('#toning-panel').scrollIntoViewIfNeeded();
await page.waitForTimeout(250);

const toningCurve = await page.evaluate(() => {
  const selectors = ['#toning-panel', '#tone-curve-container', '#histogram-container', '#preview-controls-divider'];
  return Object.fromEntries(selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) return [selector, null];
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [selector, {
      display: style.display,
      position: style.position,
      bottom: style.bottom,
      top: style.top,
      y: rect.y,
      h: rect.height,
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }];
  }));
});

await page.screenshot({ path: 'screenshots/image-layout-toning-curve.png' });

const toningCurveRows = await page.evaluate(() => {
  const visibleRowsInPanel = Array.from(document.querySelectorAll('#toning-panel .toning-slider-row')).filter((row) => {
    const style = getComputedStyle(row);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).length;
  const visibleRowsInOverlay = Array.from(document.querySelectorAll('#isolated-controls-sliders .toning-slider-row')).filter((row) => {
    const style = getComputedStyle(row);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).length;

  return {
    visibleRowsInPanel,
    visibleRowsInOverlay,
  };
});

console.log(JSON.stringify({
  initial,
  calibrationRed,
  calibrationChrome,
  calibrationXY,
  calibrationDivider,
  wheelsOpen,
  wheelsCollapsed,
  toningContrast,
  toningCurve,
  toningCurveRows,
}, null, 2));
fs.unlinkSync(tempImagePath);
await browser.close();
