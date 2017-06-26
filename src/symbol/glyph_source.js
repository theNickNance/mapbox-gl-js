'use strict';

const normalizeURL = require('../util/mapbox').normalizeGlyphsURL;
const ajax = require('../util/ajax');
const verticalizePunctuation = require('../util/verticalize_punctuation');
const Glyphs = require('../util/glyphs');
const GlyphAtlas = require('../symbol/glyph_atlas');
const Protobuf = require('pbf');
const TinySDF = require('tiny-sdf');
const scriptDetection = require('../util/script_detection');

// A simplified representation of the glyph containing only the properties needed for shaping.
class SimpleGlyph {
    constructor(glyph, rect, buffer) {
        const padding = 1;
        this.advance = glyph.advance;
        this.left = glyph.left - buffer - padding;
        this.top = glyph.top + buffer + padding;
        this.rect = rect;
    }
}

/**
 * A glyph source has a URL from which to load new glyphs and manages
 * GlyphAtlases in which to store glyphs used by the requested fontstacks
 * and ranges.
 *
 * @private
 */
class GlyphSource {
    /**
     * @param {string} url glyph template url
     */
    constructor(url) {
        this.url = url && normalizeURL(url);
        this.atlases = {};
        this.stacks = {};
        this.loading = {};
    }

    getSimpleGlyphs(fontstack, glyphIDs, uid, callback) {
        if (this.stacks[fontstack] === undefined) {
            this.stacks[fontstack] = {};
        }
        if (this.atlases[fontstack] === undefined) {
            this.atlases[fontstack] = new GlyphAtlas();
        }

        const glyphs = {};
        const stack = this.stacks[fontstack];
        const atlas = this.atlases[fontstack];

        // the number of pixels the sdf bitmaps are padded by
        const buffer = 3;

        const missing = {};
        let remaining = 0;

        const getGlyph = (glyphID) => {
            const range = Math.floor(glyphID / 256);

            if (stack[range]) {
                const glyph = stack[range].glyphs[glyphID];
                const rect  = atlas.addGlyph(uid, fontstack, glyph, buffer);
                if (glyph) glyphs[glyphID] = new SimpleGlyph(glyph, rect, buffer);
            } else {
                if (missing[range] === undefined) {
                    missing[range] = [];
                    remaining++;
                }
                missing[range].push(glyphID);
            }
        };

        for (let i = 0; i < glyphIDs.length; i++) {
            const glyphID = glyphIDs[i];
            const string = String.fromCharCode(glyphID);
            getGlyph(glyphID);
            if (verticalizePunctuation.lookup[string]) {
                getGlyph(verticalizePunctuation.lookup[string].charCodeAt(0));
            }
        }

        if (!remaining) callback(undefined, glyphs, fontstack);

        const onRangeLoaded = (err, range, data) => {
            if (!err) {
                const stack = this.stacks[fontstack][range] = data.stacks[0];
                for (let i = 0; i < missing[range].length; i++) {
                    const glyphID = missing[range][i];
                    const glyph = stack.glyphs[glyphID];
                    const rect  = atlas.addGlyph(uid, fontstack, glyph, buffer);
                    if (glyph) glyphs[glyphID] = new SimpleGlyph(glyph, rect, buffer);
                }
            }
            remaining--;
            if (!remaining) callback(undefined, glyphs, fontstack);
        };

        for (const r in missing) {
            this.loadRange(fontstack, r, onRangeLoaded);
        }
    }

    loadCJKRange(fontstack, range, callback) {
        // Rough implementation: do it synchronously, ignore fontstack and use default font
        // Generate all glyphs in the range, even if they aren't being used
        const glyphs = {
            stacks: [
                {
                    name: fontstack,
                    range: range,
                    glyphs: {}
                }]
        };
        const fontSize = 24;
        const buffer = 2;
        const radius = fontSize / 3;
        const sdf = new TinySDF(fontSize, buffer, radius);
        for (let i = 0; i < 256; i++) {
            const glyphID = range * 256 + i;
            const imgData = sdf.draw(String.fromCharCode(glyphID));
            const alphaData = new Uint8Array(imgData.data.length / 4);
            for (let i = 0; i < imgData.data.length; i++) {
                if (i % 4 === 0) {
                    alphaData[i / 4] = imgData.data[i];
                }
            }
            const glyph = {
                id: glyphID,
                bitmap: alphaData,
                width: 22,
                height: 22,
                left: 1,
                top: -6,
                advance: 24
            };
            glyphs.stacks[0].glyphs[glyphID] = glyph;
        }
        callback(null, range, glyphs);
    }

    loadRange(fontstack, range, callback) {
        if (range * 256 > 65535) return callback('glyphs > 65535 not supported');
        if (range * 256 >= 0x4E00 && range * 256 <= 0x9FFF) {
            this.loadCJKRange(fontstack, range, callback);
            return;
        }

        if (this.loading[fontstack] === undefined) {
            this.loading[fontstack] = {};
        }
        const loading = this.loading[fontstack];

        if (loading[range]) {
            loading[range].push(callback);
        } else {
            loading[range] = [callback];

            const rangeName = `${range * 256}-${range * 256 + 255}`;
            const url = glyphUrl(fontstack, rangeName, this.url);

            ajax.getArrayBuffer(url, (err, response) => {
                const glyphs = !err && new Glyphs(new Protobuf(response.data));
                for (let i = 0; i < loading[range].length; i++) {
                    loading[range][i](err, range, glyphs);
                }
                delete loading[range];
            });
        }
    }

    getGlyphAtlas(fontstack) {
        return this.atlases[fontstack];
    }
}

/**
 * Use CNAME sharding to load a specific glyph range over a randomized
 * but consistent subdomain.
 * @param {string} fontstack comma-joined fonts
 * @param {string} range comma-joined range
 * @param {url} url templated url
 * @param {string} [subdomains=abc] subdomains as a string where each letter is one.
 * @returns {string} a url to load that section of glyphs
 * @private
 */
function glyphUrl(fontstack, range, url, subdomains) {
    subdomains = subdomains || 'abc';

    return url
        .replace('{s}', subdomains[fontstack.length % subdomains.length])
        .replace('{fontstack}', fontstack)
        .replace('{range}', range);
}

module.exports = GlyphSource;
