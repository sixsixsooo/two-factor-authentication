# Локальные скрипты и веса TensorFlow.js

- **`tfjs/`**, **`mobilenet/`**, **`knn-classifier/`**, **`blazeface/`** — копируются из `node_modules` скриптом `npm run vendor:tf` (вызывается и в `postinstall`).
- **`mobilenet-model/`** — веса MobileNet v2 (как в `@tensorflow-models/mobilenet` v2 / α=1.0), скачиваются с TensorFlow Hub (`?tfjs-format=file`) скриптом `npm run vendor:model` (в `postinstall` пропуск, если файлы уже есть).
- **`blazeface-model/`** — веса BlazeFace (tfhub `tensorflow/tfjs-model/blazeface/1`), скрипт `npm run vendor:blazeface`.

После `git clone` достаточно `npm install`: скрипты и модели подтянутся автоматически (для скачивания весов нужен интернет один раз, если папки пусты).
