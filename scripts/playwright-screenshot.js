import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const candidatePaths = [
    path.join(process.env.LOCALAPPDATA || 'C:\\Users\\%USERNAME%\\AppData\\Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join('C:', 'Program Files', 'Microsoft VS Code', 'Code.exe'),
    path.join('C:', 'Program Files (x86)', 'Microsoft VS Code', 'Code.exe'),
    path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('C:', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('C:', 'Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join('C:', 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

async function tryConnectAndScreenshot(exe, targetFile, outFile) {
    try {
        console.log('Launching via', exe);
        const browser = await chromium.launch({ executablePath: exe, headless: true });
        const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
        const page = await context.newPage();

        const fileUrl = 'file://' + path.resolve(targetFile).replace(/\\/g, '/');
        console.log('Navigating to', fileUrl);
        await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });

        // wait a short moment for any runtime JS to finish
        await page.waitForTimeout(800);

        const outDir = path.dirname(outFile);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        await page.screenshot({ path: outFile, fullPage: true });
        console.log('Saved screenshot to', outFile);

        await browser.close();
        return true;
    } catch (err) {
        console.warn('Screenshot attempt failed with', exe, '-', err.message.replace(/\n/g, ' '));
        return false;
    }
}

(async () => {
    const target = process.argv[2] || 'dist/index.html';
    const out = process.argv[3] || 'screenshots/playwright-snap.png';

    for (const p of candidatePaths) {
        if (!p) continue;
        if (fs.existsSync(p)) {
            const ok = await tryConnectAndScreenshot(p, target, out);
            if (ok) return process.exit(0);
        }
    }

    console.error('No working browser found to take screenshot.');
    process.exit(2);
})();
