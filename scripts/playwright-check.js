import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const candidatePaths = [
    // VS Code default install locations (Windows)
    path.join(process.env.LOCALAPPDATA || 'C:\Users\%USERNAME%\AppData\Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join('C:', 'Program Files', 'Microsoft VS Code', 'Code.exe'),
    path.join('C:', 'Program Files (x86)', 'Microsoft VS Code', 'Code.exe'),
    // Chrome
    path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('C:', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    // Edge
    path.join('C:', 'Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join('C:', 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

async function tryLaunch(exe) {
    try {
        console.log('Trying executable:', exe);
        const browser = await chromium.launch({ executablePath: exe, headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto('about:blank');
        console.log('Launch successful with', exe);
        await browser.close();
        return true;
    } catch (err) {
        console.warn('Launch failed for', exe, '-', err.message.replace(/\n/g, ' '));
        return false;
    }
}

(async () => {
    console.log('Playwright check: looking for a usable Chromium/Chrome/Edge executable...');

    for (const p of candidatePaths) {
        if (!p) continue;
        if (fs.existsSync(p)) {
            const ok = await tryLaunch(p);
            if (ok) return process.exit(0);
        } else {
            // print only if path looks reasonable
            // console.log('Not found:', p);
        }
    }

    console.log('\nNo usable browser executable found in common locations.');
    console.log('Options:');
    console.log('- Allow Playwright to download browsers (run `npx playwright install chromium`).');
    console.log('- Start an external Chrome/Edge with remote-debugging and connect via CDP.');
    console.log('- Run this script from a machine that has Chrome/Edge available.');
    process.exit(2);
})();
