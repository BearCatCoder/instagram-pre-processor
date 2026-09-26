#target photoshop

(function () {
    function base64(value) {
        var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        var text = unescape(encodeURIComponent(String(value || "")));
        var output = "";
        var index = 0;
        while (index < text.length) {
            var a = text.charCodeAt(index++);
            var b = text.charCodeAt(index++);
            var c = text.charCodeAt(index++);
            var e1 = a >> 2;
            var e2 = ((a & 3) << 4) | (b >> 4);
            var e3 = isNaN(b) ? 64 : ((b & 15) << 2) | (c >> 6);
            var e4 = isNaN(c) ? 64 : c & 63;
            output += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + chars.charAt(e4);
        }
        return output;
    }

    function localized(xmp, namespace, property) {
        try { return String(xmp.getLocalizedText(namespace, property, "", "x-default") || ""); } catch (_) { return ""; }
    }

    function property(xmp, namespace, name) {
        try { return String(xmp.getProperty(namespace, name) || ""); } catch (_) { return ""; }
    }

    var originalDialogs = app.displayDialogs;
    var originalUnits = app.preferences.rulerUnits;
    var doc = null;
    var metadata = new File(RPP_CONFIG.metadata);
    try {
        app.displayDialogs = DialogModes.NO;
        app.preferences.rulerUnits = Units.PIXELS;
        doc = app.open(new File(RPP_CONFIG.input));

        if (ExternalObject.AdobeXMPScript === undefined) {
            ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
        }
        var xmp = new XMPMeta(doc.xmpMetadata.rawData);
        var core = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";
        var exif = "http://ns.adobe.com/exif/1.0/";
        var extended = localized(xmp, core, "ExtDescrAccessibility");
        var keywords = "";
        try { keywords = doc.info.keywords.join(", "); } catch (_) {}
        var location = [];
        try { if (doc.info.city) location.push(doc.info.city); } catch (_) {}
        try { if (doc.info.provinceState) location.push(doc.info.provinceState); } catch (_) {}
        try { if (doc.info.country) location.push(doc.info.country); } catch (_) {}
        var latitude = property(xmp, exif, "GPSLatitude");
        var longitude = property(xmp, exif, "GPSLongitude");
        var gps = latitude && longitude ? latitude + ", " + longitude : "";
        var values = [
            doc.info.title || "", doc.info.caption || "", extended, keywords,
            doc.info.author || "", doc.info.copyrightNotice || "", location.join(", "), gps
        ];
        metadata.encoding = "UTF-8";
        if (!metadata.open("w")) throw new Error("Could not write temporary metadata file.");
        for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
            if (valueIndex) metadata.write("\t");
            metadata.write(base64(values[valueIndex]));
        }
        metadata.close();

        doc.flatten();
        if (doc.mode !== DocumentMode.RGB) doc.changeMode(ChangeMode.RGB);
        if (doc.bitsPerChannel !== BitsPerChannelType.EIGHT) doc.bitsPerChannel = BitsPerChannelType.EIGHT;
        var width = doc.width.as("px");
        var height = doc.height.as("px");
        var longest = Math.max(width, height);
        if (longest > 1600) {
            var factor = 1600 / longest;
            doc.resizeImage(UnitValue(Math.round(width * factor), "px"), UnitValue(Math.round(height * factor), "px"), null, ResampleMethod.BICUBICSHARPER);
        }
        var options = new JPEGSaveOptions();
        options.quality = 10;
        options.embedColorProfile = true;
        options.formatOptions = FormatOptions.STANDARDBASELINE;
        doc.saveAs(new File(RPP_CONFIG.preview), options, true, Extension.LOWERCASE);
    } finally {
        try { if (metadata.opened) metadata.close(); } catch (_) {}
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        app.displayDialogs = originalDialogs;
        app.preferences.rulerUnits = originalUnits;
    }
}());
