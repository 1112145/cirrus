import { describe, expect, it } from 'vitest';
import { extensionOf, extname, formatTitle, mimeAllowed, mimeMatches, parseBytes, stem, storageExtension } from '../src/index.ts';

describe('formatTitle (port of @directus/format-title)', () => {
  it('formats file names as Directus does', () => {
    expect(formatTitle('my-holiday_photo')).toBe('My Holiday Photo');
    expect(formatTitle('camelCaseName')).toBe('Camel Case Name');
    expect(formatTitle('the-lord-of-the-rings')).toBe('The Lord of the Rings');
    expect(formatTitle('api-docs-pdf')).toBe('API Docs PDF');
    expect(formatTitle('iphone-photo')).toBe('iPhone Photo');
    expect(formatTitle('IMG_1234')).toBe('Img 1234');
    expect(formatTitle('report 2024')).toBe('Report 2024');
  });
});

describe('names and types', () => {
  it('splits extensions like Node path', () => {
    expect(extname('photo.JPG')).toBe('.JPG');
    expect(extname('archive.tar.gz')).toBe('.gz');
    expect(extname('.env')).toBe('');
    expect(extname('dir.d/file')).toBe('');
    expect(stem('archive.tar.gz')).toBe('archive.tar');
    expect(stem('C:\\x\\photo.png')).toBe('photo');
    expect(stem('README')).toBe('README');
  });

  it('picks the stored extension from the name, else the type', () => {
    expect(storageExtension('Photo.JPG', 'image/jpeg')).toBe('.jpg');
    expect(storageExtension('photo', 'image/jpeg')).toBe('.jpeg');
    expect(storageExtension('photo', 'application/x-unknown')).toBe('');
    expect(storageExtension('weird.ext with space', 'image/png')).toBe('.png');
    expect(extensionOf('text/plain; charset=utf-8')).toBe('txt');
    expect(extensionOf(null)).toBeNull();
  });

  it('matches MIME types against allow list patterns', () => {
    expect(mimeMatches('image/png', '*/*')).toBe(true);
    expect(mimeMatches('image/png', 'image/*')).toBe(true);
    expect(mimeMatches('IMAGE/PNG', 'image/png')).toBe(true);
    expect(mimeMatches('video/mp4', 'image/*')).toBe(false);
    expect(mimeMatches('image/svg+xml', 'image/svg+xml')).toBe(true);
    expect(mimeMatches('image/png', '*')).toBe(false);
    expect(mimeAllowed('application/pdf', ['image/*', 'application/pdf'])).toBe(true);
    expect(mimeAllowed('text/html', ['image/*', 'application/pdf'])).toBe(false);
  });
});

describe('parseBytes', () => {
  it('reads sizes as the bytes package does', () => {
    expect(parseBytes('100mb')).toBe(100 * 1024 * 1024);
    expect(parseBytes('1.5 KB')).toBe(1536);
    expect(parseBytes('2048')).toBe(2048);
    expect(parseBytes('10b')).toBe(10);
    expect(parseBytes('lots')).toBeNull();
    expect(parseBytes(undefined)).toBeNull();
  });
});
