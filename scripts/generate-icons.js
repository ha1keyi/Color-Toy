// Generate PNG icons from SVG sources using sharp
// Usage: npm install sharp --save-dev
//        npm run icons:gen

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const iconsDir = path.resolve(process.cwd(), 'public', 'icons');
const svg192 = path.join(iconsDir, 'icon-192.svg');
const svg512 = path.join(iconsDir, 'icon-512.svg');

async function gen() {
  if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

  try {
    if (fs.existsSync(svg192)) {
      await sharp(svg192).resize(192, 192).png().toFile(path.join(iconsDir, 'icon-192.png'));
      console.log('Generated icon-192.png');
    } else {
      console.warn('Missing', svg192);
    }

    if (fs.existsSync(svg512)) {
      await sharp(svg512).resize(512, 512).png().toFile(path.join(iconsDir, 'icon-512.png'));
      console.log('Generated icon-512.png');
    } else {
      console.warn('Missing', svg512);
    }
  } catch (err) {
    console.error('Icon generation failed:', err);
    process.exitCode = 1;
  }
}

gen();
