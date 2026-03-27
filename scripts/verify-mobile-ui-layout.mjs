import { chromium } from 'playwright';

function toVisible(styleDisplay) {
  return styleDisplay !== 'none';
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});

const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});

const previewUrl = process.env.COLOR_TOY_PREVIEW_URL || 'http://127.0.0.1:4176/';
await page.goto(previewUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const testSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#8c8c8c"/></svg>';
await page.setInputFiles('#image-input', {
  name: 'verify.svg',
  mimeType: 'image/svg+xml',
  buffer: Buffer.from(testSvg),
});
await page.waitForTimeout(650);

await page.locator('.mobile-module-btn[data-mobile-module="mapping"]').click({ force: true });
await page.waitForTimeout(350);

async function ensureMappingMode(mode) {
  const selector = `#mapping-mode-tabs [data-mapping-mode="${mode}"]`;
  await page.locator(selector).click({ force: true });
  await page.waitForTimeout(220);
  const current = await page.evaluate(() => document.getElementById('mapping-panel')?.getAttribute('data-mapping-mode'));
  if (current !== mode) {
    await page.evaluate((targetMode) => {
      const btn = document.querySelector(`#mapping-mode-tabs [data-mapping-mode="${targetMode}"]`);
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }, mode);
    await page.waitForTimeout(220);
  }
}

async function snapshotMapping(label) {
  const state = await page.evaluate((tag) => {
    const panel = document.getElementById('mapping-panel');
    const list = document.getElementById('mapping-list');
    const actions = document.querySelector('#mapping-panel .mapping-actions');
    const picker = document.getElementById('picker-coord-readout');
    const tabs = document.getElementById('mapping-mode-tabs');
    const isolated = document.getElementById('isolated-controls-sliders');

    const styleOf = (el) => (el ? getComputedStyle(el).display : null);
    const rectOf = (el) => (el ? el.getBoundingClientRect() : null);

    const panelRect = rectOf(panel);
    const isolatedRect = rectOf(isolated);

    const overlap = panelRect && isolatedRect
      ? Math.max(0, Math.min(panelRect.bottom, isolatedRect.bottom) - Math.max(panelRect.top, isolatedRect.top))
      : null;

    return {
      label: tag,
      layout: document.documentElement.getAttribute('data-ui-layout'),
      mode: panel?.getAttribute('data-mapping-mode') || null,
      activeModeTab: document.querySelector('#mapping-mode-tabs .submodule-tab.active')?.getAttribute('data-mapping-mode') || null,
      listDisplay: styleOf(list),
      actionsDisplay: styleOf(actions),
      pickerDisplay: styleOf(picker),
      tabsDisplay: styleOf(tabs),
      isolatedDisplay: styleOf(isolated),
      overlap,
      panelHeight: panelRect?.height || 0,
      isolatedTop: isolatedRect?.top || 0,
      tabsBottom: rectOf(tabs)?.bottom || 0,
    };
  }, label);

  await page.screenshot({ path: `screenshots/verify-${label}.png` });
  return state;
}

const globalState = await snapshotMapping('mapping-global');
await ensureMappingMode('point');
const pointState = await snapshotMapping('mapping-point');
await ensureMappingMode('picker');
const pickerState = await snapshotMapping('mapping-picker');

await page.evaluate(() => document.getElementById('wheels-dock-btn')?.click());
await page.waitForTimeout(280);

const wheelsOpen = await page.evaluate(() => {
  const row = document.getElementById('wheels-row');
  const dock = document.getElementById('wheels-dock-btn');
  return {
    rowDisplay: row ? getComputedStyle(row).display : null,
    rowClass: row?.className || null,
    dockClass: dock?.className || null,
  };
});
await page.screenshot({ path: 'screenshots/verify-wheels-open.png' });

await page.evaluate(() => document.getElementById('wheels-dock-btn')?.click());
await page.waitForTimeout(220);

const wheelsCollapsed = await page.evaluate(() => {
  const row = document.getElementById('wheels-row');
  const dock = document.getElementById('wheels-dock-btn');
  const afterContent = dock ? getComputedStyle(dock, '::after').content : null;
  return {
    rowDisplay: row ? getComputedStyle(row).display : null,
    rowClass: row?.className || null,
    dockClass: dock?.className || null,
    dockTitle: dock?.getAttribute('title') || null,
    dockAfterContent: afterContent,
  };
});
await page.screenshot({ path: 'screenshots/verify-wheels-collapsed.png' });

const checks = {
  mappingPointModeSwitch: pointState.mode === 'point' && pointState.activeModeTab === 'point',
  mappingPointVisible: toVisible(pointState.listDisplay) && toVisible(pointState.actionsDisplay),
  mappingPickerModeSwitch: pickerState.mode === 'picker' && pickerState.activeModeTab === 'picker',
  mappingPickerVisible: toVisible(pickerState.pickerDisplay),
  mappingNoOverlap: (pointState.overlap ?? 999) <= 0 && (pickerState.overlap ?? 999) <= 0,
  wheelsOpenInsideLayout: wheelsOpen.rowDisplay === 'flex' && (wheelsOpen.rowClass || '').includes('wheels-compare-inside'),
  wheelsCollapsedOutBadge: wheelsCollapsed.rowDisplay === 'none'
    && (wheelsCollapsed.dockClass || '').includes('mode-out')
    && String(wheelsCollapsed.dockAfterContent || '').includes('IN/OUT')
    && String(wheelsCollapsed.dockTitle || '').includes('In/Out'),
};

const ok = Object.values(checks).every(Boolean);

console.log(JSON.stringify({
  checks,
  globalState,
  pointState,
  pickerState,
  wheelsOpen,
  wheelsCollapsed,
}, null, 2));

await browser.close();

if (!ok) {
  process.exit(1);
}
