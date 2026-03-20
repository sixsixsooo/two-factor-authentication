/**
 * Копирует минифицированные TF.js, MobileNet, KNN из node_modules в public/vendor/
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');

function copy(relFrom, relTo) {
  const src = path.join(nm, relFrom);
  const dest = path.join(root, 'public', relTo);
  if (!fs.existsSync(src)) {
    console.error('Missing:', src);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('Copied', relTo);
}

copy('@tensorflow/tfjs/dist/tf.min.js', 'vendor/tfjs/tf.min.js');
copy('@tensorflow-models/mobilenet/dist/mobilenet.min.js', 'vendor/mobilenet/mobilenet.min.js');
copy('@tensorflow-models/knn-classifier/dist/knn-classifier.min.js', 'vendor/knn-classifier/knn-classifier.min.js');
