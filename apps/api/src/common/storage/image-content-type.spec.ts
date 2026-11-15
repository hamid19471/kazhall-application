import {
  EMPTY,
  GIF_1X1,
  JPEG_8X8,
  NOT_AN_IMAGE,
  PNG_8X8,
  SVG_DOCUMENT,
  TRUNCATED_JPEG,
  TRUNCATED_PNG,
  WEBP_8X8,
} from '../../../test/support/image-fixtures';
import {
  extensionForImageType,
  inspectImageBuffer,
  SUPPORTED_IMAGE_MIME_TYPES,
} from './image-content-type';

/**
 * These run against REAL encoder output — see `test/support/image-fixtures.ts`.
 * A test that fed this module `Buffer.from('fake')` would pass against a
 * one-line implementation and prove nothing about either direction.
 */
describe('inspectImageBuffer', () => {
  describe('accepts the three supported formats', () => {
    it.each([
      ['PNG', PNG_8X8, 'image/png'],
      ['JPEG', JPEG_8X8, 'image/jpeg'],
      ['WebP', WEBP_8X8, 'image/webp'],
    ])('%s', (_label, buffer, expected) => {
      const result = inspectImageBuffer(buffer);
      expect(result.mime).toBe(expected);
      expect(result.rejection).toBeNull();
    });

    it('agrees with the exported list of supported types', () => {
      const detected = [PNG_8X8, JPEG_8X8, WEBP_8X8].map(
        (b) => inspectImageBuffer(b).mime,
      );
      expect(new Set(detected)).toEqual(new Set(SUPPORTED_IMAGE_MIME_TYPES));
    });
  });

  describe('refuses formats this project does not accept', () => {
    /**
     * The security case. SVG is a document that can carry `<script>`, and one
     * served from the asset host executes if anybody opens it directly.
     */
    it('refuses SVG, and says it recognised it', () => {
      const result = inspectImageBuffer(SVG_DOCUMENT);
      expect(result.mime).toBeNull();
      expect(result.rejection).toBe('unsupported');
      expect(result.detail).toContain('svg');
    });

    it('refuses SVG that leads with whitespace and no XML prologue', () => {
      const bare = Buffer.from('\n  <svg xmlns="http://www.w3.org/2000/svg"/>');
      expect(inspectImageBuffer(bare).rejection).toBe('unsupported');
    });

    it('refuses GIF', () => {
      expect(inspectImageBuffer(GIF_1X1).rejection).toBe('unsupported');
    });

    it.each([
      ['PDF', Buffer.from('%PDF-1.7\n...')],
      ['ZIP / docx', Buffer.from('PK\x03\x04')],
      ['BMP', Buffer.from('BM\x36\x00')],
      ['TIFF', Buffer.from('II\x2a\x00rest')],
      [
        'HEIC / AVIF',
        Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]),
      ],
    ])('refuses %s', (_label, buffer) => {
      expect(inspectImageBuffer(buffer as Buffer).rejection).toBe(
        'unsupported',
      );
    });

    /** The spoofed-extension case: named and declared as an image, isn't one. */
    it('refuses a file that is not an image at all', () => {
      const result = inspectImageBuffer(NOT_AN_IMAGE);
      expect(result.mime).toBeNull();
      expect(result.rejection).toBe('unsupported');
    });
  });

  describe('distinguishes malformed from unsupported', () => {
    it('treats a truncated PNG as malformed, not unsupported', () => {
      // The sender clearly meant PNG — the signature is perfect. The fix is
      // "send it again", not "send a different format".
      const result = inspectImageBuffer(TRUNCATED_PNG);
      expect(result.rejection).toBe('malformed');
    });

    it('treats a JPEG with no end-of-image marker as malformed', () => {
      expect(inspectImageBuffer(TRUNCATED_JPEG).rejection).toBe('malformed');
    });

    it('treats a PNG declaring a zero dimension as malformed', () => {
      const zeroWidth = Buffer.from(PNG_8X8);
      zeroWidth.writeUInt32BE(0, 16);
      expect(inspectImageBuffer(zeroWidth).rejection).toBe('malformed');
    });

    it('treats a WebP whose declared size disagrees with its length as malformed', () => {
      const lying = Buffer.from(WEBP_8X8);
      lying.writeUInt32LE(9999, 4);
      expect(inspectImageBuffer(lying).rejection).toBe('malformed');
    });

    it('refuses a RIFF container that is not WebP', () => {
      const avi = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('AVI LIST'),
      ]);
      expect(inspectImageBuffer(avi).mime).toBeNull();
    });

    it('treats an empty buffer as empty, not malformed', () => {
      // A different message: nothing arrived, as opposed to something broken.
      expect(inspectImageBuffer(EMPTY).rejection).toBe('empty');
    });

    it.each([[undefined], [null]])('treats %p as empty', (input) => {
      expect(inspectImageBuffer(input as undefined).rejection).toBe('empty');
    });
  });

  describe('trailing data', () => {
    /**
     * Padding after a complete PNG must not make it malformed — that is how
     * the oversize test builds a file whose ONLY problem is its size.
     */
    it('accepts a valid PNG with bytes appended', () => {
      const padded = Buffer.concat([PNG_8X8, Buffer.alloc(4096)]);
      expect(inspectImageBuffer(padded).mime).toBe('image/png');
    });
  });
});

describe('extensionForImageType', () => {
  it('normalises the stored extension from the VERIFIED type', () => {
    expect(extensionForImageType('image/jpeg')).toBe('jpg');
    expect(extensionForImageType('image/png')).toBe('png');
    expect(extensionForImageType('image/webp')).toBe('webp');
  });
});
