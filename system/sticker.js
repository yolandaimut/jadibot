// --- konversi media gambar/video ke webp dan penyisipan metadata exif stiker ---
import fs from 'fs';
import { tmpdir } from 'os';
import ffmpeg from 'fluent-ffmpeg';
import webp from 'node-webpmux';
import path from 'path';
import crypto from 'crypto';

const uuid = () => crypto.randomBytes(10).toString('hex');
const generateTempFile = (extension) => path.join(tmpdir(), `${uuid()}.${extension}`);

function safeUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // --- abaikan error saat menghapus file sementara ---
    }
  }
}

// --- konversi buffer gambar atau video menjadi format stiker webp ---
async function convertToWebp(media, isVideo, shape = 'full') {
  const tmpFileOut = generateTempFile('webp');
  const tmpFileIn = generateTempFile(isVideo ? 'mp4' : 'jpg');

  try {
    fs.writeFileSync(tmpFileIn, media);

    let vfFilter = '';
    const outputOptions = ['-vcodec', 'libwebp'];

    if (shape === 'full') {
      if (isVideo) {
        vfFilter = `scale='min(512,iw)':min'(512,ih)':force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0,split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse`;
        outputOptions.push('-loop', '0', '-ss', '00:00:00', '-t', '00:00:09', '-preset', 'default', '-an', '-vsync', '0', '-q:v', '20', '-compression_level', '6');
      } else {
        vfFilter = `scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse`;
        outputOptions.push('-q:v', '20', '-compression_level', '6');
      }
    } else {
      vfFilter = 'scale=512:512:force_original_aspect_ratio=increase,fps=15,crop=512:512';

      if (shape === 'circle') {
        vfFilter += `,format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='if(gt((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2)\\,(W/2)*(W/2))\\,0\\,255)'`;
      }

      if (isVideo) {
        outputOptions.push('-loop', '0', '-ss', '00:00:00', '-t', '00:00:09', '-preset', 'default', '-an', '-vsync', '0', '-q:v', '20', '-compression_level', '6');
      } else {
        outputOptions.push('-q:v', '20', '-compression_level', '6');
      }
    }

    outputOptions.push('-vf', vfFilter);

    await new Promise((resolve, reject) => {
      ffmpeg(tmpFileIn)
        .on('error', reject)
        .on('end', () => resolve(true))
        .addOutputOptions(outputOptions)
        .toFormat('webp')
        .save(tmpFileOut);
    });

    return fs.readFileSync(tmpFileOut);
  } finally {
    safeUnlink(tmpFileIn);
    safeUnlink(tmpFileOut);
  }
}

// --- tulis metadata exif packname dan author ke buffer stiker webp ---
async function writeExif(media, metadata = {}, shape = 'full') {
  let wMedia;

  if (media && media.mimetype) {
    if (/webp/.test(media.mimetype)) {
      wMedia = media.data;
    } else {
      const isVideo = /video/.test(media.mimetype);
      wMedia = await convertToWebp(media.data, isVideo, shape);
    }
  } else if (Buffer.isBuffer(media)) {
    wMedia = await convertToWebp(media, false, shape);
  } else {
    wMedia = media;
  }

  if (!metadata.packname && !metadata.author) {
    return wMedia;
  }

  const tmpFileIn = generateTempFile('webp');
  const tmpFileOut = generateTempFile('webp');

  try {
    fs.writeFileSync(tmpFileIn, wMedia);

    const img = new webp.Image();
    const json = {
      'sticker-pack-id': `SuryaDev-${uuid()}`,
      'sticker-pack-name': metadata.packname || '',
      'sticker-pack-publisher': metadata.author || '',
      emojis: metadata.categories || [''],
      'web-rest-api': 'https://instagram.com/surya_skylark05',
      'is-avatar-sticker': metadata.avatar ? 1 : 0,
      'is-ai-sticker': metadata.ai ? 1 : 0,
      premium: metadata.prem ? 1 : 0
    };

    const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);

    await img.load(tmpFileIn);
    img.exif = exif;
    await img.save(tmpFileOut);

    return fs.readFileSync(tmpFileOut);
  } finally {
    safeUnlink(tmpFileIn);
    safeUnlink(tmpFileOut);
  }
}

const writeExifImg = (media, metadata, shape) => writeExif(media, metadata, shape);
const writeExifVid = (media, metadata, shape) => writeExif(media, metadata, shape);
const writeExifWebp = (media, metadata, shape) => writeExif(media, metadata, shape);

export { writeExif, writeExifImg, writeExifVid, writeExifWebp };
