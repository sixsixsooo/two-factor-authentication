/**
 * BlazeFace → обрезка лица на canvas → MobileNet v2 (conv_preds).
 * Зависит от глобалов: tf, blazeface, загруженного mobilenet.
 */
(function (global) {
  'use strict';

  var MODEL_PATH = '/vendor/blazeface-model/model.json';
  /** Запас вокруг bbox лица (доля ширины/высоты рамки). */
  var CROP_MARGIN = 0.22;

  var blazeModel = null;
  var cropCanvas = null;
  var cropCtx = null;

  function getCropCanvas() {
    if (!cropCanvas && typeof document !== 'undefined') {
      cropCanvas = document.createElement('canvas');
      cropCtx = cropCanvas.getContext('2d');
    }
    return { canvas: cropCanvas, ctx: cropCtx };
  }

  function expandBox(topLeft, bottomRight, vw, vh) {
    var x1 = topLeft[0];
    var y1 = topLeft[1];
    var x2 = bottomRight[0];
    var y2 = bottomRight[1];
    var bw = Math.max(1, x2 - x1);
    var bh = Math.max(1, y2 - y1);
    var cx = (x1 + x2) / 2;
    var cy = (y1 + y2) / 2;
    var halfW = (bw * (1 + CROP_MARGIN)) / 2;
    var halfH = (bh * (1 + CROP_MARGIN)) / 2;
    var sx = Math.floor(cx - halfW);
    var sy = Math.floor(cy - halfH);
    var sw = Math.ceil(2 * halfW);
    var sh = Math.ceil(2 * halfH);
    if (sx < 0) {
      sw += sx;
      sx = 0;
    }
    if (sy < 0) {
      sh += sy;
      sy = 0;
    }
    if (sx + sw > vw) sw = vw - sx;
    if (sy + sh > vh) sh = vh - sy;
    sw = Math.max(1, sw);
    sh = Math.max(1, sh);
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  function ensureBlazeFace() {
    if (blazeModel) return Promise.resolve(blazeModel);
    if (!global.blazeface || typeof global.blazeface.load !== 'function') {
      return Promise.reject(new Error('Пакет blazeface не загружен (подключите vendor/blazeface/blazeface.min.js)'));
    }
    return global.blazeface
      .load({
        modelUrl: MODEL_PATH,
        maxFaces: 1,
        scoreThreshold: 0.55
      })
      .then(function (m) {
        blazeModel = m;
        return m;
      });
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {*} mobilenetNet — результат mobilenet.load()
   * @param {boolean} [flipHorizontal] — как в estimateFaces для фронтальной камеры
   * @returns {Promise<*>} tf.Tensor активации conv_preds или null
   */
  function getFaceActivation(video, mobilenetNet, flipHorizontal) {
    if (!video || !mobilenetNet || !global.tf) return Promise.resolve(null);
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (!vw || !vh) return Promise.resolve(null);

    var flip = flipHorizontal === true;

    return ensureBlazeFace().then(function () {
      return blazeModel.estimateFaces(video, false, flip);
    }).then(function (faces) {
      if (!faces || faces.length === 0) return null;
      var f = faces[0];
      var tl = f.topLeft;
      var br = f.bottomRight;
      if (!tl || !br) return null;
      var box = expandBox([tl[0], tl[1]], [br[0], br[1]], vw, vh);
      var cc = getCropCanvas();
      if (!cc.ctx) return null;
      cc.canvas.width = box.sw;
      cc.canvas.height = box.sh;
      cc.ctx.drawImage(video, box.sx, box.sy, box.sw, box.sh, 0, 0, box.sw, box.sh);
      var img = global.tf.browser.fromPixels(cc.canvas);
      var act = global.tf.tidy(function () {
        return mobilenetNet.infer(img, 'conv_preds');
      });
      img.dispose();
      return act;
    });
  }

  function dispose() {
    if (blazeModel && typeof blazeModel.dispose === 'function') {
      try {
        blazeModel.dispose();
      } catch (e) {}
    }
    blazeModel = null;
  }

  global.SurvFacePipeline = {
    ensureBlazeFace: ensureBlazeFace,
    getFaceActivation: getFaceActivation,
    dispose: dispose
  };
})(typeof window !== 'undefined' ? window : globalThis);
