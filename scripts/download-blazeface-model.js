/**
 * Скачивает BlazeFace (tfjs) в public/vendor/blazeface-model/ для офлайн-загрузки без TF Hub.
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1';
const OUT = path.join(__dirname, '../public/vendor/blazeface-model');

async function downloadToFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

async function main() {
  const marker = path.join(OUT, 'group1-shard1of1.bin');
  if (fs.existsSync(marker) && fs.statSync(marker).size > 1000) {
    console.log('BlazeFace model already in public/vendor/blazeface-model (skip download).');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const modelUrl = `${BASE}/model.json?tfjs-format=file`;
  const modelPath = path.join(OUT, 'model.json');
  await downloadToFile(modelUrl, modelPath);
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const paths = new Set();
  for (const m of model.weightsManifest || []) {
    for (const p of m.paths || []) paths.add(p);
  }
  for (const p of paths) {
    await downloadToFile(`${BASE}/${p}?tfjs-format=file`, path.join(OUT, p));
    console.log('  shard', p);
  }
  console.log('BlazeFace model →', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
