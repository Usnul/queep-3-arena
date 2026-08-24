/*
 * tga.ts -- decoder for the Targa images Quake III ships.
 *
 * Copyright (C) 2026 queep-3-arena contributors
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later
 * version. See LICENSE.
 *
 * ---
 *
 * meep decodes PNG and JPEG. Q3 ships 1360 `.tga` files, so they are converted
 * offline rather than decoded at runtime.
 *
 * Only the two variants id's tools actually produced are handled: type 2
 * (uncompressed true-colour) and type 10 (RLE true-colour), at 24 or 32 bits per
 * pixel. Anything else throws with the type in the message -- a silent fallback
 * to a magenta placeholder would hide a whole class of texture from review.
 *
 * Format reference: Truevision TGA specification v2.0, sections 3 and 4.
 */

export interface DecodedImage {
    readonly width: number;
    readonly height: number;
    /** Tightly packed RGBA, top-left origin. */
    readonly rgba: Uint8Array;
    readonly hadAlpha: boolean;
}

const TYPE_UNCOMPRESSED_TRUECOLOR = 2;
const TYPE_RLE_TRUECOLOR = 10;

export function decodeTga(data: Uint8Array): DecodedImage {
    if (data.byteLength < 18) {
        throw new Error('TGA: file shorter than its 18-byte header');
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const idLength = data[0]!;
    const colorMapType = data[1]!;
    const imageType = data[2]!;
    const width = view.getUint16(12, true);
    const height = view.getUint16(14, true);
    const bpp = data[16]!;
    const descriptor = data[17]!;

    if (colorMapType !== 0) {
        throw new Error(`TGA: colour-mapped images are not supported (colour map type ${colorMapType})`);
    }

    if (imageType !== TYPE_UNCOMPRESSED_TRUECOLOR && imageType !== TYPE_RLE_TRUECOLOR) {
        throw new Error(
            `TGA: unsupported image type ${imageType} ` +
            `(expected 2 uncompressed or 10 RLE true-colour)`
        );
    }

    if (bpp !== 24 && bpp !== 32) {
        throw new Error(`TGA: unsupported bit depth ${bpp} (expected 24 or 32)`);
    }

    if (width <= 0 || height <= 0) {
        throw new Error(`TGA: bad dimensions ${width}x${height}`);
    }

    const bytesPerPixel = bpp >> 3;
    // Bit 5 of the descriptor: 0 means the first row in the file is the *bottom*
    // row of the image, which is the usual case for the Q3 asset set.
    const topOrigin = (descriptor & 0x20) !== 0;

    let p = 18 + idLength;
    const pixelCount = width * height;
    const rgba = new Uint8Array(pixelCount * 4);

    // Decode into file order first, then flip if needed. Flipping during the RLE
    // walk would mean tracking row boundaries through runs that cross them.
    const linear = new Uint8Array(pixelCount * 4);

    if (imageType === TYPE_UNCOMPRESSED_TRUECOLOR) {
        const need = pixelCount * bytesPerPixel;
        if (p + need > data.byteLength) {
            throw new Error(
                `TGA: truncated -- need ${need} pixel bytes, ${data.byteLength - p} available`
            );
        }
        for (let i = 0; i < pixelCount; i++) {
            const src = p + i * bytesPerPixel;
            const d = i * 4;
            linear[d] = data[src + 2]!;
            linear[d + 1] = data[src + 1]!;
            linear[d + 2] = data[src]!;
            linear[d + 3] = bytesPerPixel === 4 ? data[src + 3]! : 255;
        }
    } else {
        let i = 0;
        while (i < pixelCount) {
            if (p >= data.byteLength) {
                throw new Error(`TGA: truncated RLE stream at pixel ${i} of ${pixelCount}`);
            }

            const packet = data[p]!;
            p += 1;
            const count = (packet & 0x7f) + 1;

            if ((packet & 0x80) !== 0) {
                // Run-length packet: one pixel repeated `count` times.
                const d0 = i * 4;
                linear[d0] = data[p + 2]!;
                linear[d0 + 1] = data[p + 1]!;
                linear[d0 + 2] = data[p]!;
                linear[d0 + 3] = bytesPerPixel === 4 ? data[p + 3]! : 255;
                p += bytesPerPixel;

                for (let k = 1; k < count && i + k < pixelCount; k++) {
                    linear.copyWithin((i + k) * 4, d0, d0 + 4);
                }
            } else {
                // Raw packet: `count` distinct pixels.
                for (let k = 0; k < count && i + k < pixelCount; k++) {
                    const src = p + k * bytesPerPixel;
                    const d = (i + k) * 4;
                    linear[d] = data[src + 2]!;
                    linear[d + 1] = data[src + 1]!;
                    linear[d + 2] = data[src]!;
                    linear[d + 3] = bytesPerPixel === 4 ? data[src + 3]! : 255;
                }
                p += count * bytesPerPixel;
            }

            i += count;
        }
    }

    if (topOrigin) {
        rgba.set(linear);
    } else {
        const rowBytes = width * 4;
        for (let y = 0; y < height; y++) {
            const from = (height - 1 - y) * rowBytes;
            rgba.set(linear.subarray(from, from + rowBytes), y * rowBytes);
        }
    }

    let hadAlpha = false;
    if (bytesPerPixel === 4) {
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i] !== 255) {
                hadAlpha = true;
                break;
            }
        }
    }

    return { width, height, rgba, hadAlpha };
}
