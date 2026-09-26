#target photoshop

(function () {
    function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
    function number(value, fallback, low, high) {
        value = Number(value);
        if (!isFinite(value)) value = fallback;
        return clamp(value, low, high);
    }
    function integer(value, fallback, low, high) { return Math.round(number(value, fallback, low, high)); }

    function applyFinish(doc, finish) {
        finish = finish || {};
        var exposure = number(finish.exposure, 0, -2, 2);
        if (Math.abs(exposure) > 0.001) {
            var exposureSettings = new ActionDescriptor();
            exposureSettings.putDouble(charIDToTypeID("Exps"), exposure);
            exposureSettings.putDouble(charIDToTypeID("Ofst"), 0);
            exposureSettings.putDouble(charIDToTypeID("Gmm "), 1);
            executeAction(charIDToTypeID("Exps"), exposureSettings, DialogModes.NO);
        }

        var black = integer(finish.levelsBlack, 0, 0, 40);
        var white = integer(finish.levelsWhite, 255, 215, 255);
        var gamma = number(finish.levelsGamma, 1, 0.5, 1.5);
        if (black || white !== 255 || Math.abs(gamma - 1) > 0.001) doc.activeLayer.adjustLevels(black, white, gamma, 0, 255);

        var brightness = integer(finish.brightness, 0, -50, 50);
        var contrast = integer(finish.contrast, 0, -50, 50);
        if (brightness || contrast) doc.activeLayer.adjustBrightnessContrast(brightness, contrast);

        var shadow = integer(64 + number(finish.curveShadows, 0, -30, 30), 64, 1, 125);
        var midtone = integer(128 + number(finish.curveMidtones, 0, -30, 30), 128, shadow + 1, 190);
        var highlight = integer(192 + number(finish.curveHighlights, 0, -30, 30), 192, midtone + 1, 254);
        if (shadow !== 64 || midtone !== 128 || highlight !== 192) {
            doc.activeLayer.adjustCurves([[0, 0], [64, shadow], [128, midtone], [192, highlight], [255, 255]]);
        }

        var cyanRed = integer(finish.cyanRed, 0, -30, 30);
        var magentaGreen = integer(finish.magentaGreen, 0, -30, 30);
        var yellowBlue = integer(finish.yellowBlue, 0, -30, 30);
        if (cyanRed || magentaGreen || yellowBlue) {
            doc.activeLayer.adjustColorBalance([0, 0, 0], [cyanRed, magentaGreen, yellowBlue], [0, 0, 0], true);
        }

        var vibrance = integer(finish.vibrance, 0, -50, 50);
        if (vibrance) {
            var vibranceSettings = new ActionDescriptor();
            vibranceSettings.putInteger(stringIDToTypeID("vibrance"), vibrance);
            vibranceSettings.putInteger(stringIDToTypeID("saturation"), 0);
            executeAction(stringIDToTypeID("vibrance"), vibranceSettings, DialogModes.NO);
        }
        var saturation = integer(finish.saturation, 0, -30, 30);
        if (saturation) doc.activeLayer.adjustHueSaturation(0, saturation, 0);
    }

    if (!RPP_CONFIG.overwrite && new File(RPP_CONFIG.output).exists) throw new Error("Instagram output already exists and overwrite is disabled.");
    var originalDialogs = app.displayDialogs;
    var originalUnits = app.preferences.rulerUnits;
    var doc = null;
    try {
        app.displayDialogs = DialogModes.NO;
        app.preferences.rulerUnits = Units.PIXELS;
        doc = app.open(new File(RPP_CONFIG.input));
        doc.flatten();
        if (doc.mode !== DocumentMode.RGB) doc.changeMode(ChangeMode.RGB);
        if (doc.bitsPerChannel !== BitsPerChannelType.EIGHT) doc.bitsPerChannel = BitsPerChannelType.EIGHT;

        var sourceWidth = doc.width.as("px");
        var sourceHeight = doc.height.as("px");
        var angle = number(RPP_CONFIG.straightenDegrees, 0, -45, 45);
        if (Math.abs(angle) > 0.001) doc.rotateCanvas(angle);
        var width = doc.width.as("px");
        var height = doc.height.as("px");
        var radians = Math.abs(angle) * Math.PI / 180;
        var safeSide = Math.min(sourceWidth / (Math.cos(radians) + Math.sin(radians)), sourceHeight / (Math.sin(radians) + Math.cos(radians)));
        if (!isFinite(safeSide) || safeSide <= 0) safeSide = Math.min(width, height);
        safeSide = Math.floor(Math.min(safeSide, width, height) * number(RPP_CONFIG.cropScale, 0.96, 0.5, 1));
        safeSide = Math.max(2, safeSide);
        var centerX = number(RPP_CONFIG.cropCenterX, 0.5, 0, 1) * width;
        var centerY = number(RPP_CONFIG.cropCenterY, 0.5, 0, 1) * height;
        centerX = clamp(centerX, safeSide / 2, width - safeSide / 2);
        centerY = clamp(centerY, safeSide / 2, height - safeSide / 2);
        var left = clamp(Math.round(centerX - safeSide / 2), 0, width - safeSide);
        var top = clamp(Math.round(centerY - safeSide / 2), 0, height - safeSide);
        doc.crop([UnitValue(left, "px"), UnitValue(top, "px"), UnitValue(left + safeSide, "px"), UnitValue(top + safeSide, "px")]);

        applyFinish(doc, RPP_CONFIG.finish);
        var outputSize = integer(RPP_CONFIG.outputSize, 1080, 320, 4096);
        doc.resizeImage(UnitValue(outputSize, "px"), UnitValue(outputSize, "px"), null, ResampleMethod.BICUBICSHARPER);
        try { doc.convertProfile("sRGB IEC61966-2.1", Intent.PERCEPTUAL, true, true); } catch (_) {}

        if (ExternalObject.AdobeXMPScript === undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
        }
        var core = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";
        var xmp = new XMPMeta(doc.xmpMetadata.rawData);
        xmp.setLocalizedText(core, "ExtDescrAccessibility", "", "x-default", RPP_CONFIG.extendedDescription);
        doc.xmpMetadata.rawData = xmp.serialize();

        var options = new JPEGSaveOptions();
        options.quality = 12;
        options.embedColorProfile = true;
        options.formatOptions = FormatOptions.STANDARDBASELINE;
        doc.saveAs(new File(RPP_CONFIG.output), options, true, Extension.LOWERCASE);
    } finally {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        app.displayDialogs = originalDialogs;
        app.preferences.rulerUnits = originalUnits;
    }
}());
