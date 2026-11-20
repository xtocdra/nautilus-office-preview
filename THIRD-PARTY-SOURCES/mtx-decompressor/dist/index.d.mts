//#region src/errors.d.ts
/**
 * Structured error type for the MTX/EOT decoder.
 *
 * Mirrors libeot's `enum EOTError` (MPL 2.0 — inc/libeot/EOTError.h) so that
 * failures are machine-discriminable via a stable `code` rather than only a
 * human-readable message. Codes at or above {@link EOT_WARN} denote recoverable
 * warnings ("the font is usable, but…") as opposed to fatal errors.
 */
/** Threshold at or above which a code is a non-fatal warning. */
export declare const EOT_WARN = 1000;
/** Discriminable error/warning codes, mirroring libeot's `enum EOTError`. */
export declare enum EotErrorCode {
  InsufficientBytes = "INSUFFICIENT_BYTES",
  HeaderTooBig = "HEADER_TOO_BIG",
  BogusStringSize = "BOGUS_STRING_SIZE",
  CorruptFile = "CORRUPT_FILE",
  LogicError = "LOGIC_ERROR",
  NoMaxpTable = "NO_MAXP_TABLE",
  NoHeadTable = "NO_HEAD_TABLE",
  NoHmtxTable = "NO_HMTX_TABLE",
  CorruptHopcodeData = "CORRUPT_HOPCODE_DATA",
  MalformedHeadTable = "MALFORMED_HEAD_TABLE",
  /** A byte-level read/write/seek was attempted while mid-byte (`bitPos != 0`). */
  OffByteBoundary = "OFF_BYTE_BOUNDARY",
  /** A write or copy would exceed the stream's reserved capacity. */
  OutOfReservedSpace = "OUT_OF_RESERVED_SPACE",
  /** A seek would move past the stream's reserved end. */
  SeekPastEos = "SEEK_PAST_EOS",
  MtxError = "MTX_ERROR",
  /** Recoverable: the coded version was wrong but a retry succeeded. */
  WarnBadVersion = "WARN_BAD_VERSION",
  /** Recoverable: uncompressed font data lacks a recognised sfnt signature. */
  WarnNotSfnt = "WARN_NOT_SFNT",
  /** Recoverable: `maxp` is not version 1.0 (TrueType). */
  WarnMaxpVersion = "WARN_MAXP_VERSION",
  /** Recoverable: a recommended table is absent from the font. */
  WarnMissingTable = "WARN_MISSING_TABLE"
}
/** An error (or warning) raised while decoding MTX/EOT font data. */
export declare class EotError extends Error {
  readonly code: EotErrorCode;
  constructor(code: EotErrorCode, message: string, options?: {
    cause?: unknown;
  });
  /** True when this represents a recoverable warning rather than a fatal error. */
  get isWarning(): boolean;
}
/** A recoverable diagnostic: the font was still produced. */
interface EotWarning {
  code: EotErrorCode;
  message: string;
}
//#endregion
//#region src/mtx-decompress.d.ts
/**
 * Unpack an MTX blob into three LZCOMP-decompressed streams.
 *
 * MTX header layout (10 bytes, big-endian):
 *   byte  0     : versionMagic
 *   bytes 1–3   : copyLimit  (24-bit BE, informational only)
 *   bytes 4–6   : offset2    (24-bit BE)
 *   bytes 7–9   : offset3    (24-bit BE)
 *
 * The data following the header is split into three contiguous
 * compressed blocks whose boundaries are determined by the offsets.
 *
 * @param data  Raw MTX data, i.e. the font-data region of the EOT container.
 *              Real-world EOT files (Glyphicons, Font Awesome) decode as-is;
 *              no BSGP stripping is needed.
 * @param size  Total byte length of `data`.
 * @param maxOutputBytes  Optional combined budget for the three decompressed
 *              streams. Each stream is decoded against what is left of it,
 *              so an oversized stream fails before its buffers are allocated.
 * @returns An object containing the three decompressed byte arrays and
 *          their respective sizes.
 */
export declare function unpackMtx(data: Uint8Array, size: number, maxOutputBytes?: number): {
  streams: Uint8Array[];
  sizes: number[];
};
/** Default ceiling on the size of a reconstructed font (128 MiB). */
export declare const DEFAULT_MAX_OUTPUT_BYTES: number;
/** Options accepted by {@link decompressMtx}. */
interface DecompressOptions {
  encrypted?: boolean;
  compressed?: boolean;
  onWarn?: (message: string) => void;
  /** Structured variant of {@link onWarn}: receives `{ code, message }`. */
  onWarning?: (warning: EotWarning) => void;
  /**
   * Upper bound on the reconstructed font size in bytes, guarding against
   * decompression bombs. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}; pass
   * `Infinity` to disable.
   */
  maxOutputBytes?: number;
}
/**
 * Decompress an MTX-compressed font (e.g. from an EOT wrapper) into a
 * standard sfnt font binary (TrueType, or OpenType/CFF).
 *
 * @param fontData    Raw font bytes (MTX-compressed, optionally encrypted).
 * @param options.encrypted   If `true`, XOR-decrypt with {@link ENCRYPTION_KEY}.
 * @param options.compressed  If `false`, skip decompression and return the
 *                            (possibly decrypted) data as-is.
 * @param options.maxOutputBytes  Cap on the reconstructed font size.
 * @param options.onWarn      Optional hook invoked with a message for each
 *                            non-fatal diagnostic. The font is still produced.
 * @returns A `Uint8Array` containing a valid sfnt font: TrueType, or OpenType/CFF (`OTTO`).
 */
export declare function decompressMtx(fontData: Uint8Array, options?: DecompressOptions): Uint8Array;
/**
 * Decompress an EOT-embedded font.
 *
 * This is a thin wrapper around {@link decompressMtx} that accepts explicit
 * boolean parameters instead of an options object.
 *
 * @param fontData    Raw font bytes extracted from the EOT container.
 * @param compressed  Whether the data is MTX-compressed.
 * @param encrypted   Whether the data is XOR-encrypted.
 * @returns A `Uint8Array` containing a valid sfnt font: TrueType, or OpenType/CFF (`OTTO`).
 */
export declare function decompressEotFont(fontData: Uint8Array, compressed: boolean, encrypted: boolean): Uint8Array;
//#endregion
//#region src/stream.d.ts
export declare class Stream {
  buf: Uint8Array;
  size: number;
  reserved: number;
  pos: number;
  bitPos: number;
  constructor(buf: Uint8Array | null, size: number);
  static fromExisting(buf: Uint8Array, size: number, reserved: number): Stream;
  reserve(n: number): void;
  /**
   * Reject byte-level access while the stream sits mid-byte (`bitPos != 0`).
   *
   * libeot returns `EOT_OFF_BYTE_BOUNDARY` for any byte read/write/seek issued
   * before a partial byte has been consumed. The bit-level reader
   * ({@link readNBits}) is the sole legitimate mid-byte accessor and bypasses
   * this guard by touching `buf`/`pos` directly. On valid input the only
   * `readNBits` caller consumes whole bytes per point, so the stream is always
   * byte-aligned when a byte accessor runs and this guard never fires.
   */
  private ensureByteAligned;
  private ensureWrite;
  private ensureRead;
  seekAbsolute(pos: number): void;
  seekRelative(offset: number): void;
  seekAbsoluteThroughReserve(pos: number): void;
  seekRelativeThroughReserve(offset: number): void;
  readU8(): number;
  peekU8(): number;
  readU16(): number;
  readU24(): number;
  readU32(): number;
  readS16(): number;
  readS8(): number;
  readChar(): string;
  writeU8(v: number): void;
  writeU16(v: number): void;
  writeU24(v: number): void;
  writeU32(v: number): void;
  writeS16(v: number): void;
  writeS8(v: number): void;
  readNBits(n: number): number;
  /**
   * Copy `length` bytes from this stream to `dest`.
   *
   * Both streams must be byte-aligned. The destination must already have the
   * capacity reserved: libeot returns `EOT_OUT_OF_RESERVED_SPACE` when a copy
   * would overrun the reserved buffer, so we throw rather than auto-growing —
   * an under-reservation is a bug we want surfaced, not silently patched.
   */
  copyTo(dest: Stream, length: number): void;
  /** Read rest of data as 4-byte-aligned U32 values. Returns 0 on incomplete read. */
  readRestAsU32(): number | null;
  /**
   * Compute the SFNT-style checksum of bytes in `[beginPos, endPos)` as a sum
   * of big-endian U32 words, zero-padding a final partial word. Bounds strictly
   * on `endPos` (not the stream's `size`), so an unaligned range never folds in
   * bytes past `endPos`. Leaves the stream position unchanged.
   */
  checksumU32(beginPos: number, endPos: number): number;
  /** Get a copy of the written data. */
  toUint8Array(): Uint8Array;
}
//#endregion
//#region src/ctf-parser.d.ts
/** A single SFNT table record. */
interface SFNTTable {
  /** 4-character tag (e.g. "head", "maxp", "glyf", "loca"). */
  tag: string;
  /** Offset into the original CTF stream (or final offset in the output). */
  offset: number;
  /** Size of the table data in bytes. */
  bufSize: number;
  /** Raw table data. */
  buf: Uint8Array;
  /** Table checksum. */
  checksum: number;
}
/** Collection of SFNT tables that constitute a font. */
interface SFNTContainer {
  tables: SFNTTable[];
  /**
   * sfnt version written to the offset table: `0x00010000` (TrueType
   * outlines), `0x4f54544f` ('OTTO', CFF outlines) or `0x74727565` ('true').
   * Defaults to `0x00010000` when absent.
   */
  scalarType?: number;
  /**
   * Legacy diagnostic field. Supported metric tables are now reconstructed
   * rather than dropped, so this field is no longer populated.
   */
  droppedTables?: string[];
}
/** Optional hooks for {@link parseCTF}. */
interface ParseCTFOptions {
  /**
   * Invoked once per non-fatal diagnostic.
   * Lets callers surface warnings without the library writing to `console`.
   */
  onWarn?: (message: string) => void;
  /** Structured variant of {@link onWarn}. */
  onWarning?: (warning: EotWarning) => void;
}
/**
 * Parse a CTF (Compact TrueType Font) container from the three LZCOMP-
 * decompressed streams and produce an `SFNTContainer` that can be
 * serialized into a standard TrueType font file.
 *
 * @param streams  Three `Stream` objects produced by MTX decompression:
 *                   [0] = glyph / table data
 *                   [1] = push instruction data
 *                   [2] = hinting code data
 * @returns An `SFNTContainer` holding all reconstructed SFNT tables.
 */
export declare function parseCTF(streams: Stream[], options?: ParseCTFOptions): SFNTContainer;
//#endregion
//#region src/sfnt-builder.d.ts
/**
 * Assemble a complete TrueType font binary from an `SFNTContainer`.
 *
 * Steps:
 *  1. Compute required output size and allocate a `Stream`.
 *  2. Write the offset table (12 bytes).
 *  3. Reserve space for the table directory.
 *  4. Write each table's data, computing per-table checksums.
 *  5. Seek back and write the table directory.
 *  6. Compute whole-font checksum and patch the `head` table's
 *     `checksumAdjustment` field.
 *  7. Return the assembled bytes.
 */
export declare function dumpContainer(ctr: SFNTContainer, options?: {
  maxOutputBytes?: number;
}): Uint8Array;
//#endregion
//#region src/eot.d.ts
/** The font is a subset of the original. */
export declare const TTEMBED_SUBSET = 1;
/** The font data is MTX-compressed. */
export declare const TTEMBED_TTCOMPRESSED = 4;
/** The font data is XOR-obfuscated with key 0x50. */
export declare const TTEMBED_XORENCRYPTDATA = 268435456;
/** EOT header version. */
type EotVersion = 1 | 2 | 3;
/** Parsed EOT container metadata. */
interface EotMetadata {
  /** EOT header version (1, 2, or 3). */
  version: EotVersion;
  /** Raw `Flags` field (see the `TTEMBED_*` constants). */
  flags: number;
  /** 10-byte PANOSE classification. */
  panose: Uint8Array;
  /** `Charset` byte. */
  charset: number;
  /** Whether the font is italic. */
  italic: boolean;
  /** Weight (100–900). */
  weight: number;
  /** `fsType` embedding permissions (see {@link canLegallyEdit}). */
  permissions: number;
  /** The four `UnicodeRange` bitmask words. */
  unicodeRange: [number, number, number, number];
  /** The two `CodePageRange` bitmask words. */
  codePageRange: [number, number];
  /** `head.checkSumAdjustment` copied from the original font. */
  checkSumAdjustment: number;
  /** Font family name (decoded from UTF-16LE). */
  familyName: string;
  /** Subfamily / style name. */
  styleName: string;
  /** Version name string. */
  versionName: string;
  /** Full font name. */
  fullName: string;
  /** Root string (version 2+), else an empty string. */
  rootString: string;
  /** Declared total size of the EOT file, in bytes. */
  totalSize: number;
  /** Size of the embedded font data, in bytes. */
  fontDataSize: number;
  /** Absolute offset at which the font data begins. */
  fontDataOffset: number;
  /** True when the font data is MTX-compressed (`flags & TTEMBED_TTCOMPRESSED`). */
  compressed: boolean;
  /** True when the font data is XOR-encrypted (`flags & TTEMBED_XORENCRYPTDATA`). */
  encrypted: boolean;
  /** Version 3 only: checksum of the root string (0 otherwise). */
  rootStringChecksum: number;
  /** Version 3 only: EUDC code page (0 otherwise). */
  eudcCodePage: number;
  /** Version 3 only: EUDC flags (0 otherwise). */
  eudcFlags: number;
  /** Version 3 only: embedded EUDC font data, when present. */
  eudcFontData?: Uint8Array;
  /** True when the font is a subset of the original (`flags & TTEMBED_SUBSET`). */
  subset: boolean;
  /**
   * True when the version magic in the file disagreed with the version that
   * actually parsed cleanly. The font is still usable (libeot returns
   * `EOT_WARN_BAD_VERSION` in this case), but the header was inconsistent.
   */
  badVersion: boolean;
}
/**
 * Protection-related information declared by an EOT container.
 *
 * EOT defines XOR obfuscation for FontData, plus separate embedding and
 * RootString restrictions. It defines no password-protection mechanism;
 * this result says nothing about an outer document or archive containing EOT.
 */
interface EotProtection {
  /** EOT FontData transform declared by TTEMBED_XORENCRYPTDATA. */
  encryption: 'none' | 'xor-0x50';
  /** EOT has no password-protection field or password-based encryption. */
  passwordProtection: 'not_supported_by_eot';
  /** fsType embedding permission bits copied into the EOT header. */
  embeddingPermissions: number;
  /** RootString URL restrictions; an empty string means none are declared. */
  rootString: string;
}
/** Any binary input the public API accepts. */
type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView;
/** Structural stand-in for `Blob`/`File` (this package does not depend on the DOM lib). */
interface BlobLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}
/**
 * Parse the metadata of an EOT container.
 *
 * Reproduces libeot's `EOTfillMetadata`, including the version-retry loop that
 * copes with EOT files whose declared version disagrees with their actual
 * layout. On a corrected version {@link EotMetadata.badVersion} is set rather
 * than throwing (libeot returns the recoverable `EOT_WARN_BAD_VERSION`).
 *
 * @param input Raw `.eot` file bytes (`Uint8Array`, `ArrayBuffer` or any typed-array view).
 * @throws {EotError} on a corrupt or truncated container.
 */
export declare function parseEotMetadata(input: BinaryInput): EotMetadata;
/**
 * Inspect the protection indicators declared by an EOT container.
 *
 * This reports EOT's XOR transform independently from `fsType` embedding
 * permissions and RootString URL restrictions. EOT has no password-based
 * protection mechanism; this cannot determine whether an outer file or
 * document containing the EOT is password-protected.
 *
 * @param input Raw `.eot` file bytes (`Uint8Array`, `ArrayBuffer` or any typed-array view).
 * @throws {EotError} on a corrupt or truncated container.
 */
export declare function inspectEotProtection(input: BinaryInput): EotProtection;
/** Options for {@link eotToTtf}. */
interface EotToTtfOptions {
  onWarn?: (message: string) => void;
  /** Structured variant of {@link onWarn}: receives `{ code, message }`. */
  onWarning?: (warning: EotWarning) => void;
  maxOutputBytes?: number;
}
/**
 * Decode a raw EOT container straight into a font binary: TrueType (.ttf), or OpenType/CFF (`OTTO`) when the outlines are CFF.
 *
 * Parses the header, locates and slices the embedded font data, and runs it
 * through {@link decompressMtx} using the container's own
 * compressed/encrypted flags. This is the drop-in equivalent of libeot's
 * `EOT2ttf_*` entry points.
 *
 * @param input Raw `.eot` file bytes (`Uint8Array`, `ArrayBuffer` or any typed-array view).
 * @returns The reconstructed font (TrueType, or OpenType/CFF).
 * @param options.maxOutputBytes Cap on the reconstructed font size (default 128 MiB).
 * @param options.onWarn Called for recovered header-version mismatches and
 * non-fatal decompression diagnostics.
 * @throws {EotError} on a corrupt container or during decompression.
 */
export declare function eotToTtf(input: BinaryInput, options?: EotToTtfOptions): Uint8Array;
/**
 * Whether the font's embedding permissions allow editing.
 *
 * Mirrors libeot's `EOTcanLegallyEdit`. The upstream author asks that callers
 * reflect before circumventing this: installable-permission fonts (`fsType`
 * 0) and editable-embedding fonts may be edited; others may not.
 */
export declare function canLegallyEdit(metadata: EotMetadata): boolean;
/**
 * Promise-returning variant of {@link eotToTtf} that also accepts a `Blob`/`File`
 * (convenient in browsers). Decoding itself still runs synchronously once the
 * bytes are available.
 */
export declare function eotToTtfAsync(input: BinaryInput | BlobLike, options?: EotToTtfOptions): Promise<Uint8Array>;
//#endregion
export type { BinaryInput, BlobLike, DecompressOptions, EotMetadata, EotProtection, EotToTtfOptions, EotVersion, EotWarning, ParseCTFOptions, SFNTContainer, SFNTTable };