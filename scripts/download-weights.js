const https = require('https');
const fs = require('fs');
const path = require('path');

// Важно: веса должны соответствовать face-api.js 0.22.2 (у master другая архитектура — ошибка тензора)
const BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/0.22.2/weights';
const FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2'
];

const outDir = path.join(__dirname, '..', 'public', 'weights');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${url} => ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function main() {
  for (const file of FILES) {
    const url = `${BASE}/${file}`;
    process.stdout.write(`Downloading ${file}... `);
    try {
      const buf = await download(url);
      fs.writeFileSync(path.join(outDir, file), buf);
      console.log('OK');
    } catch (e) {
      console.log('FAIL:', e.message);
    }
  }
}

main();
