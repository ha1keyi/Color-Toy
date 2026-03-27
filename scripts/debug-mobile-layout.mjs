import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});

const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  document.documentElement.setAttribute('data-ui-layout', 'controls-priority');
  const controls = document.getElementById('controls');
  const calibrationPanel = document.getElementById('calibration-panel');
  const wheelsPanel = document.getElementById('wheels-panel');
  const wheelsRow = document.getElementById('wheels-row');
  const historyPanel = document.getElementById('history-panel');
  const bottomBar = document.getElementById('bottom-bar');
  const presetSection = document.getElementById('preset-section');
  const capabilities = document.getElementById('capabilities');
  const colorManagementPanel = document.getElementById('color-management-panel');
  const calibrationTabs = document.getElementById('calibration-primary-tabs');
  const slider = document.getElementById('isolated-cal-sliders');

  if (controls) {
    controls.classList.add('module-calibration');
    controls.dataset.mobileModule = 'calibration';
    controls.dataset.calPrimary = 'red';
  }
  if (calibrationPanel) {
    calibrationPanel.style.display = 'block';
    calibrationPanel.setAttribute('data-cal-primary', 'red');
  }
  if (wheelsPanel) wheelsPanel.style.display = 'none';
  if (wheelsRow) wheelsRow.style.display = 'none';
  if (historyPanel) historyPanel.style.display = 'none';
  if (bottomBar) bottomBar.style.display = 'none';
  if (presetSection) presetSection.style.display = 'none';
  if (capabilities) capabilities.style.display = 'none';
  if (colorManagementPanel) colorManagementPanel.style.display = 'none';
  if (calibrationTabs) calibrationTabs.style.display = 'flex';
  if (slider) slider.style.display = 'block';
  window.scrollTo(0, 0);
});
await page.waitForTimeout(500);

const data = await page.evaluate(() => {
  const calibrationTabs = document.getElementById('calibration-primary-tabs');
  const slider = document.getElementById('isolated-cal-sliders');
  const calRect = calibrationTabs?.getBoundingClientRect();
  const sliderRect = slider?.getBoundingClientRect();
  const calStyle = calibrationTabs ? getComputedStyle(calibrationTabs) : null;
  const sliderStyle = slider ? getComputedStyle(slider) : null;

  return {
    layout: document.documentElement.getAttribute('data-ui-layout'),
    controlsClass: document.getElementById('controls')?.className,
    mobileModule: document.getElementById('controls')?.dataset.mobileModule,
    calibrationTabs: calibrationTabs
      ? {
          display: calStyle?.display,
          position: calStyle?.position,
          bottom: calStyle?.bottom,
          y: calRect?.y,
          h: calRect?.height,
          text: calibrationTabs.textContent?.replace(/\s+/g, ' ').trim(),
        }
      : null,
    slider: slider
      ? {
          display: sliderStyle?.display,
          position: sliderStyle?.position,
          bottom: sliderStyle?.bottom,
          y: sliderRect?.y,
          h: sliderRect?.height,
          text: slider.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80),
        }
      : null,
  };
});

await page.screenshot({ path: 'screenshots/mobile-debug-viewport.png', fullPage: false });
console.log(JSON.stringify(data, null, 2));

await browser.close();