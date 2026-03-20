/**
 * Скачивает MobileNet v2 (как в @tensorflow-models/mobilenet v2 / alpha 1.0) в public/vendor/mobilenet-model/
 * для офлайн-загрузки без TF Hub в рантайме.
 */
const fs = require('fs');
const path = require('path');

const BASE =
  'https://tfhub.dev/google/imagenet/mobilenet_v2_100_224/classification/2';
const OUT = path.join(__dirname, '../public/vendor/mobilenet-model');

async function downloadToFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

async function main() {
  const marker = path.join(OUT, 'group1-shard4of4.bin');
  if (fs.existsSync(marker) && fs.statSync(marker).size > 1000) {
    console.log('MobileNet model already in public/vendor/mobilenet-model (skip download).');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const modelUrl = `${BASE}/model.json?tfjs-format=file`;
  const modelPath = path.join(OUT, 'model.json');
  await downloadToFile(modelUrl, modelPath);
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const manifests = model.weightsManifest || [];
  const paths = new Set();
  for (const m of manifests) {
    for (const p of m.paths || []) paths.add(p);
  }
  for (const p of paths) {
    await downloadToFile(`${BASE}/${p}?tfjs-format=file`, path.join(OUT, p));
    console.log('  shard', p);
  }
  console.log('MobileNet model →', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
