Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/errors.ts
/**
* Structured error type for the MTX/EOT decoder.
*
* Mirrors libeot's `enum EOTError` (MPL 2.0 — inc/libeot/EOTError.h) so that
* failures are machine-discriminable via a stable `code` rather than only a
* human-readable message. Codes at or above {@link EOT_WARN} denote recoverable
* warnings ("the font is usable, but…") as opposed to fatal errors.
*/
/** Threshold at or above which a code is a non-fatal warning. */
const EOT_WARN = 1e3;
/** Discriminable error/warning codes, mirroring libeot's `enum EOTError`. */
let EotErrorCode = /* @__PURE__ */ function(EotErrorCode) {
	EotErrorCode["InsufficientBytes"] = "INSUFFICIENT_BYTES";
	EotErrorCode["HeaderTooBig"] = "HEADER_TOO_BIG";
	EotErrorCode["BogusStringSize"] = "BOGUS_STRING_SIZE";
	EotErrorCode["CorruptFile"] = "CORRUPT_FILE";
	EotErrorCode["LogicError"] = "LOGIC_ERROR";
	EotErrorCode["NoMaxpTable"] = "NO_MAXP_TABLE";
	EotErrorCode["NoHeadTable"] = "NO_HEAD_TABLE";
	EotErrorCode["NoHmtxTable"] = "NO_HMTX_TABLE";
	EotErrorCode["CorruptHopcodeData"] = "CORRUPT_HOPCODE_DATA";
	EotErrorCode["MalformedHeadTable"] = "MALFORMED_HEAD_TABLE";
	/** A byte-level read/write/seek was attempted while mid-byte (`bitPos != 0`). */
	EotErrorCode["OffByteBoundary"] = "OFF_BYTE_BOUNDARY";
	/** A write or copy would exceed the stream's reserved capacity. */
	EotErrorCode["OutOfReservedSpace"] = "OUT_OF_RESERVED_SPACE";
	/** A seek would move past the stream's reserved end. */
	EotErrorCode["SeekPastEos"] = "SEEK_PAST_EOS";
	EotErrorCode["MtxError"] = "MTX_ERROR";
	/** Recoverable: the coded version was wrong but a retry succeeded. */
	EotErrorCode["WarnBadVersion"] = "WARN_BAD_VERSION";
	/** Recoverable: uncompressed font data lacks a recognised sfnt signature. */
	EotErrorCode["WarnNotSfnt"] = "WARN_NOT_SFNT";
	/** Recoverable: `maxp` is not version 1.0 (TrueType). */
	EotErrorCode["WarnMaxpVersion"] = "WARN_MAXP_VERSION";
	/** Recoverable: a recommended table is absent from the font. */
	EotErrorCode["WarnMissingTable"] = "WARN_MISSING_TABLE";
	return EotErrorCode;
}({});
/** Numeric tier per code — warnings sort at/above {@link EOT_WARN}. */
const WARNING_CODES = /* @__PURE__ */ new Set([
	"WARN_BAD_VERSION",
	"WARN_NOT_SFNT",
	"WARN_MAXP_VERSION",
	"WARN_MISSING_TABLE"
]);
/** An error (or warning) raised while decoding MTX/EOT font data. */
var EotError = class EotError extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.name = "EotError";
		this.code = code;
		Object.setPrototypeOf(this, EotError.prototype);
	}
	/** True when this represents a recoverable warning rather than a fatal error. */
	get isWarning() {
		return WARNING_CODES.has(this.code);
	}
};
/** Rethrow anything that is not an {@link EotError} as a `CorruptFile` EotError, keeping the cause. */
function toEotError(err) {
	if (err instanceof EotError) return err;
	return new EotError("CORRUPT_FILE", `malformed font data: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
}
/** Dispatch a warning to whichever sinks are set. */
function emitWarning(sinks, code, message) {
	sinks?.onWarn?.(message);
	sinks?.onWarning?.({
		code,
		message
	});
}
//#endregion
//#region src/stream.ts
/**
* Binary stream reader/writer for big-endian data.
* Ported from libeot (MPL 2.0) util/stream.c
*/
var Stream = class Stream {
	buf;
	size;
	reserved;
	pos;
	bitPos;
	constructor(buf, size) {
		if (buf) {
			this.buf = buf;
			this.size = size;
			this.reserved = buf.length;
		} else {
			this.buf = /* @__PURE__ */ new Uint8Array(0);
			this.size = 0;
			this.reserved = 0;
		}
		this.pos = 0;
		this.bitPos = 0;
	}
	static fromExisting(buf, size, reserved) {
		const s = new Stream(null, 0);
		s.buf = buf;
		s.size = size;
		s.reserved = reserved;
		return s;
	}
	reserve(n) {
		if (this.reserved >= n) return;
		const newBuf = new Uint8Array(Math.max(n, this.reserved * 2));
		newBuf.set(this.buf.subarray(0, this.size));
		this.buf = newBuf;
		this.reserved = newBuf.length;
	}
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
	ensureByteAligned() {
		if (this.bitPos !== 0) throw new EotError("OFF_BYTE_BOUNDARY", `Stream: byte-level access at a non-byte boundary (bitPos=${this.bitPos}, pos=${this.pos})`);
	}
	ensureWrite(n) {
		this.ensureByteAligned();
		const needed = this.pos + n;
		if (needed > this.reserved) this.reserve(Math.max(needed, this.reserved * 2 || 256));
		if (needed > this.size) this.size = needed;
	}
	ensureRead(n) {
		this.ensureByteAligned();
		if (this.pos + n > this.size) throw new EotError("INSUFFICIENT_BYTES", `Stream: not enough data (need ${n} bytes at pos ${this.pos}, size ${this.size})`);
	}
	seekAbsolute(pos) {
		this.ensureByteAligned();
		if (!Number.isInteger(pos) || pos < 0) throw new EotError("CORRUPT_FILE", `Stream: invalid seek position (${pos})`);
		if (pos > this.size) throw new EotError("SEEK_PAST_EOS", `Stream: seek past end (${pos} > ${this.size})`);
		this.pos = pos;
	}
	seekRelative(offset) {
		this.ensureByteAligned();
		const newPos = this.pos + offset;
		if (!Number.isInteger(offset) || !Number.isInteger(newPos)) throw new EotError("CORRUPT_FILE", `Stream: invalid relative seek (${offset})`);
		if (newPos < 0) throw new EotError("CORRUPT_FILE", "Stream: negative seek");
		if (newPos > this.size) throw new EotError("SEEK_PAST_EOS", "Stream: seek past end");
		this.pos = newPos;
	}
	seekAbsoluteThroughReserve(pos) {
		this.ensureByteAligned();
		if (pos > this.reserved) throw new EotError("SEEK_PAST_EOS", `Stream: seek to ${pos} past reserved end (${this.reserved})`);
		if (pos > this.size) this.size = pos;
		this.pos = pos;
	}
	seekRelativeThroughReserve(offset) {
		this.seekAbsoluteThroughReserve(this.pos + offset);
	}
	readU8() {
		this.ensureRead(1);
		return this.buf[this.pos++];
	}
	peekU8() {
		this.ensureRead(1);
		return this.buf[this.pos];
	}
	readU16() {
		this.ensureRead(2);
		const v = this.buf[this.pos] << 8 | this.buf[this.pos + 1];
		this.pos += 2;
		return v;
	}
	readU24() {
		this.ensureRead(3);
		const v = this.buf[this.pos] << 16 | this.buf[this.pos + 1] << 8 | this.buf[this.pos + 2];
		this.pos += 3;
		return v;
	}
	readU32() {
		this.ensureRead(4);
		const v = (this.buf[this.pos] << 24 | this.buf[this.pos + 1] << 16 | this.buf[this.pos + 2] << 8 | this.buf[this.pos + 3]) >>> 0;
		this.pos += 4;
		return v;
	}
	readS16() {
		const v = this.readU16();
		return v >= 32768 ? v - 65536 : v;
	}
	readS8() {
		const v = this.readU8();
		return v >= 128 ? v - 256 : v;
	}
	readChar() {
		return String.fromCharCode(this.readU8());
	}
	writeU8(v) {
		this.ensureWrite(1);
		this.buf[this.pos++] = v & 255;
	}
	writeU16(v) {
		this.ensureWrite(2);
		this.buf[this.pos++] = v >> 8 & 255;
		this.buf[this.pos++] = v & 255;
	}
	writeU24(v) {
		if (v < 0 || v > 16777215) throw new Error(`Stream: writeU24 value out of range: ${v}`);
		this.ensureWrite(3);
		this.buf[this.pos++] = v >> 16 & 255;
		this.buf[this.pos++] = v >> 8 & 255;
		this.buf[this.pos++] = v & 255;
	}
	writeU32(v) {
		this.ensureWrite(4);
		this.buf[this.pos++] = v >>> 24 & 255;
		this.buf[this.pos++] = v >> 16 & 255;
		this.buf[this.pos++] = v >> 8 & 255;
		this.buf[this.pos++] = v & 255;
	}
	writeS16(v) {
		this.writeU16(v < 0 ? v + 65536 : v);
	}
	writeS8(v) {
		this.writeU8(v < 0 ? v + 256 : v);
	}
	readNBits(n) {
		if (n === 0) return 0;
		if (n > 32) throw new Error(`Stream: readNBits width out of range: ${n} (max 32)`);
		let value = 0;
		let bitsRemaining = n;
		while (bitsRemaining > 0) {
			if (this.pos >= this.size && this.bitPos === 0) throw new EotError("INSUFFICIENT_BYTES", "Stream: not enough data for bit read");
			const bitsAvailableInByte = 8 - this.bitPos;
			const bitsToRead = Math.min(bitsRemaining, bitsAvailableInByte);
			const shift = bitsAvailableInByte - bitsToRead;
			const mask = (1 << bitsToRead) - 1 << shift;
			value = value << bitsToRead | (this.buf[this.pos] & mask) >> shift;
			this.bitPos += bitsToRead;
			if (this.bitPos >= 8) {
				this.bitPos = 0;
				this.pos++;
			}
			bitsRemaining -= bitsToRead;
		}
		return value >>> 0;
	}
	/**
	* Copy `length` bytes from this stream to `dest`.
	*
	* Both streams must be byte-aligned. The destination must already have the
	* capacity reserved: libeot returns `EOT_OUT_OF_RESERVED_SPACE` when a copy
	* would overrun the reserved buffer, so we throw rather than auto-growing —
	* an under-reservation is a bug we want surfaced, not silently patched.
	*/
	copyTo(dest, length) {
		this.ensureByteAligned();
		dest.ensureByteAligned();
		if (this.pos + length > this.size) throw new EotError("INSUFFICIENT_BYTES", "Stream: not enough data for copy");
		const needed = dest.pos + length;
		if (needed > dest.reserved) throw new EotError("OUT_OF_RESERVED_SPACE", `Stream: copy of ${length} bytes exceeds reserved capacity (need ${needed}, reserved ${dest.reserved})`);
		dest.buf.set(this.buf.subarray(this.pos, this.pos + length), dest.pos);
		this.pos += length;
		dest.pos += length;
		if (dest.pos > dest.size) dest.size = dest.pos;
	}
	/** Read rest of data as 4-byte-aligned U32 values. Returns 0 on incomplete read. */
	readRestAsU32() {
		if (this.pos + 4 > this.size) {
			if (this.pos >= this.size) return null;
			let val = 0;
			const remaining = this.size - this.pos;
			for (let i = 0; i < 4; i++) {
				val <<= 8;
				if (i < remaining) val |= this.buf[this.pos + i];
			}
			this.pos = this.size;
			return val >>> 0;
		}
		return this.readU32();
	}
	/**
	* Compute the SFNT-style checksum of bytes in `[beginPos, endPos)` as a sum
	* of big-endian U32 words, zero-padding a final partial word. Bounds strictly
	* on `endPos` (not the stream's `size`), so an unaligned range never folds in
	* bytes past `endPos`. Leaves the stream position unchanged.
	*/
	checksumU32(beginPos, endPos) {
		if (beginPos > endPos) throw new Error(`Stream: checksumU32 beginPos ${beginPos} > endPos ${endPos}`);
		if (endPos > this.size) throw new Error(`Stream: checksumU32 endPos ${endPos} exceeds size ${this.size}`);
		let sum = 0;
		for (let p = beginPos; p < endPos; p += 4) {
			let word = 0;
			for (let i = 0; i < 4; i++) word = word << 8 | (p + i < endPos ? this.buf[p + i] : 0);
			sum = sum + (word >>> 0) >>> 0;
		}
		return sum;
	}
	/** Get a copy of the written data. */
	toUint8Array() {
		return this.buf.slice(0, this.size);
	}
};
//#endregion
//#region src/triplet-encodings.ts
const TRIPLET_ENCODINGS = [
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 0,
		xSign: 0,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 0,
		xSign: 0,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 256,
		xSign: 0,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 256,
		xSign: 0,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 512,
		xSign: 0,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 512,
		xSign: 0,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 768,
		xSign: 0,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 768,
		xSign: 0,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 1024,
		xSign: 0,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 0,
		yBits: 8,
		deltaX: 0,
		deltaY: 1024,
		xSign: 0,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 0,
		deltaY: 0,
		xSign: -1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 0,
		deltaY: 0,
		xSign: 1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 256,
		deltaY: 0,
		xSign: -1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 256,
		deltaY: 0,
		xSign: 1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 512,
		deltaY: 0,
		xSign: -1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 512,
		deltaY: 0,
		xSign: 1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 768,
		deltaY: 0,
		xSign: -1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 768,
		deltaY: 0,
		xSign: 1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 1024,
		deltaY: 0,
		xSign: -1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 8,
		yBits: 0,
		deltaX: 1024,
		deltaY: 0,
		xSign: 1,
		ySign: 0
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 17,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 17,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 17,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 17,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 33,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 33,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 33,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 33,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 49,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 49,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 49,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 1,
		deltaY: 49,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 17,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 17,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 17,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 17,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 33,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 33,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 33,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 33,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 49,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 49,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 49,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 17,
		deltaY: 49,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 17,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 17,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 17,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 17,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 33,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 33,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 33,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 33,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 49,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 49,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 49,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 33,
		deltaY: 49,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 17,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 17,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 17,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 17,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 33,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 33,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 33,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 33,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 49,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 49,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 49,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 2,
		xBits: 4,
		yBits: 4,
		deltaX: 49,
		deltaY: 49,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 257,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 257,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 257,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 257,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 513,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 513,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 513,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 1,
		deltaY: 513,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 257,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 257,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 257,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 257,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 513,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 513,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 513,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 257,
		deltaY: 513,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 1,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 1,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 1,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 1,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 257,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 257,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 257,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 257,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 513,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 513,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 513,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 3,
		xBits: 8,
		yBits: 8,
		deltaX: 513,
		deltaY: 513,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 4,
		xBits: 12,
		yBits: 12,
		deltaX: 0,
		deltaY: 0,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 4,
		xBits: 12,
		yBits: 12,
		deltaX: 0,
		deltaY: 0,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 4,
		xBits: 12,
		yBits: 12,
		deltaX: 0,
		deltaY: 0,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 4,
		xBits: 12,
		yBits: 12,
		deltaX: 0,
		deltaY: 0,
		xSign: 1,
		ySign: 1
	},
	{
		byteCount: 5,
		xBits: 16,
		yBits: 16,
		deltaX: 0,
		deltaY: 0,
		xSign: -1,
		ySign: -1
	},
	{
		byteCount: 5,
		xBits: 16,
		yBits: 16,
		deltaX: 0,
		deltaY: 0,
		xSign: 1,
		ySign: -1
	},
	{
		byteCount: 5,
		xBits: 16,
		yBits: 16,
		deltaX: 0,
		deltaY: 0,
		xSign: -1,
		ySign: 1
	},
	{
		byteCount: 5,
		xBits: 16,
		yBits: 16,
		deltaX: 0,
		deltaY: 0,
		xSign: 1,
		ySign: 1
	}
];
//#endregion
//#region src/magnitude.ts
/**
* Read one MTX magnitude-dependent signed value (section 5.3).
* Bits are consumed least-significant-bit first within each byte. Zero is a
* single zero bit; nonzero values are unary magnitude, terminator, then sign.
*/
function readMagnitude(stream) {
	const readBit = () => {
		if (stream.pos >= stream.size) throw new EotError("INSUFFICIENT_BYTES", "truncated magnitude value");
		const bit = stream.buf[stream.pos] >> stream.bitPos & 1;
		stream.bitPos++;
		if (stream.bitPos === 8) {
			stream.bitPos = 0;
			stream.pos++;
		}
		return bit;
	};
	if (readBit() === 0) return 0;
	let magnitude = 1;
	while (readBit() === 1) magnitude++;
	return readBit() === 1 ? -magnitude : magnitude;
}
//#endregion
//#region src/hdmx.ts
/** Translation of the MicroType Express CTF `hdmx` table to its SFNT form. */
const MAX_OUTPUT_BYTES = 67108864;
function fail(message) {
	throw new EotError("CORRUPT_FILE", `invalid hdmx table: ${message}`);
}
function u16(bytes, offset) {
	return bytes[offset] << 8 | bytes[offset + 1];
}
function u32(bytes, offset) {
	return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}
function putU16(bytes, offset, value) {
	bytes[offset] = value >>> 8;
	bytes[offset + 1] = value & 255;
}
function putU32(bytes, offset, value) {
	bytes[offset] = value >>> 24;
	bytes[offset + 1] = value >>> 16;
	bytes[offset + 2] = value >>> 8;
	bytes[offset + 3] = value;
}
/**
* Decode an `hdmx` table from CTF bytes. Tables stored uncompressed by the
* MTX encoder (complemented version field) are copied with their version
* restored and do not need metric metadata.
*/
function decodeHdmx(data, metadata) {
	if (data.length < 8) throw new EotError("INSUFFICIENT_BYTES", "truncated hdmx header");
	const encodedVersion = u16(data, 0);
	const numRecords = u16(data, 2);
	const recordSize = u32(data, 4);
	if (encodedVersion === 65535) {
		if (recordSize < 2 || recordSize % 4 !== 0) fail("invalid raw record size");
		const rawLength = 8 + numRecords * recordSize;
		if (!Number.isSafeInteger(rawLength) || rawLength > data.length) throw new EotError("INSUFFICIENT_BYTES", "truncated raw hdmx records");
		const raw = data.slice();
		putU16(raw, 0, 0);
		return raw;
	}
	if (encodedVersion !== 0) fail(`unsupported version ${encodedVersion}`);
	if (!metadata) fail("missing head/hhea/hmtx/maxp metadata");
	const { numGlyphs, unitsPerEm, numberOfHMetrics, hmtx } = metadata;
	if (!Number.isInteger(numGlyphs) || numGlyphs < 0 || numGlyphs > 65535) fail("invalid numGlyphs");
	if (!Number.isInteger(unitsPerEm) || unitsPerEm <= 0 || unitsPerEm > 65535) fail("invalid unitsPerEm");
	if (!Number.isInteger(numberOfHMetrics) || numberOfHMetrics < 1 || numberOfHMetrics > numGlyphs) fail("invalid numberOfHMetrics");
	if (recordSize !== (numGlyphs + 2 + 3 & -4)) fail("recordSize does not match glyph count");
	const outputLength = 8 + numRecords * recordSize;
	if (!Number.isSafeInteger(outputLength) || outputLength > MAX_OUTPUT_BYTES) fail("decoded table is too large");
	const headerLength = 8 + numRecords * 2;
	if (headerLength > data.length) throw new EotError("INSUFFICIENT_BYTES", "truncated hdmx record headers");
	if (headerLength + Math.ceil(numRecords * numGlyphs / 8) > data.length) throw new EotError("INSUFFICIENT_BYTES", "truncated hdmx magnitude data");
	const hmtxLength = numberOfHMetrics * 4 + (numGlyphs - numberOfHMetrics) * 2;
	if (hmtx.length < hmtxLength) fail("hmtx table is too short");
	const advances = new Uint16Array(numGlyphs);
	let lastAdvance = 0;
	for (let glyph = 0; glyph < numGlyphs; glyph++) {
		if (glyph < numberOfHMetrics) lastAdvance = u16(hmtx, glyph * 4);
		advances[glyph] = lastAdvance;
	}
	const out = new Uint8Array(outputLength);
	putU16(out, 0, encodedVersion);
	putU16(out, 2, numRecords);
	putU32(out, 4, recordSize);
	const bits = new Stream(data.subarray(headerLength), data.length - headerLength);
	for (let record = 0; record < numRecords; record++) {
		const sourceRecord = 8 + record * 2;
		const targetRecord = 8 + record * recordSize;
		const ppem = data[sourceRecord];
		out[targetRecord] = ppem;
		out[targetRecord + 1] = data[sourceRecord + 1];
		for (let glyph = 0; glyph < numGlyphs; glyph++) {
			const aw = advances[glyph];
			const rounded64 = Math.floor((64 * ppem * aw + unitsPerEm / 2) / unitsPerEm);
			const width = Math.floor((rounded64 + 32) / 64) + readMagnitude(bits);
			if (width < 0 || width > 255) fail(`decoded width out of range (${width})`);
			out[targetRecord + 2 + glyph] = width;
		}
	}
	return out;
}
//#endregion
//#region src/vdmx.ts
/**
* Decode the MTX magnitude-compressed VDMX table back to OpenType form.
*
* `data` is the bounded compressed byte range, beginning at the table's
* version field. Ratio offsets retain their reconstructed OpenType positions;
* compressed groups are read sequentially from offset[0] and expanded into
* those locations. The returned array may be larger than `data`.
*/
function malformed(message) {
	throw new EotError("CORRUPT_FILE", `malformed VDMX table: ${message}`);
}
function ensureRange(start, length, limit, what) {
	if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start + length > limit) malformed(`${what} is outside the ${limit}-byte table`);
}
function toInt16$1(value, what) {
	if (!Number.isInteger(value) || value < -32768 || value > 32767) malformed(`${what} is outside the signed 16-bit range`);
	return value;
}
function validateUncompressed(data) {
	if (data.length < 6) malformed("table is shorter than its header");
	const input = new Stream(data, data.length);
	const version = input.readU16();
	if (version !== 0 && version !== 1) malformed(`unsupported OpenType version ${version}`);
	const numRecs = input.readU16();
	const numRatios = input.readU16();
	if (numRecs === 0 || numRatios === 0) malformed("table must contain at least one group and ratio");
	const headerEnd = 6 + numRatios * 6;
	ensureRange(6, numRatios * 4, data.length, "ratio records");
	input.seekAbsolute(6 + numRatios * 4);
	const offsets = [];
	for (let i = 0; i < numRatios; i++) offsets.push(input.readU16());
	const groupStarts = [...new Set(offsets)].sort((a, b) => a - b);
	if (groupStarts.length !== numRecs) malformed(`ratio offsets identify ${groupStarts.length} groups, header declares ${numRecs}`);
	for (let i = 0; i < groupStarts.length; i++) {
		const start = groupStarts[i];
		if (start < headerEnd) malformed("group offset overlaps the header");
		ensureRange(start, 4, data.length, `group ${i} header`);
		input.seekAbsolute(start);
		const recs = input.readU16();
		input.readU8();
		input.readU8();
		if (recs === 0) malformed(`group ${i} has no records`);
		const size = 4 + recs * 6;
		const limit = groupStarts[i + 1] ?? data.length;
		if (start + size > limit) malformed(`group ${i} extends past its table boundary`);
		let previousPpem = -1;
		for (let j = 0; j < recs; j++) {
			const ppem = input.readU16();
			input.readS16();
			input.readS16();
			if (ppem <= previousPpem) malformed(`group ${i} has unsorted ppem heights`);
			previousPpem = ppem;
		}
	}
}
/**
* Decode a bounded CTF VDMX table. Uncompressed fallback tables are copied
* through with their original version restored, as prescribed by MTX §5.5.
*/
function decodeVdmx(data) {
	if (data.length < 2) throw new EotError("INSUFFICIENT_BYTES", "VDMX table is shorter than its version field");
	const input = new Stream(data, data.length);
	const version = input.readU16();
	if (version > 1) {
		const originalVersion = 65535 - version;
		if (originalVersion !== 0 && originalVersion !== 1) malformed(`unsupported version marker ${version}`);
		const output = data.slice();
		output[0] = originalVersion >>> 8;
		output[1] = originalVersion & 255;
		validateUncompressed(output);
		return output;
	}
	ensureRange(0, 6, data.length, "header");
	const numRecs = input.readU16();
	const numRatios = input.readU16();
	if (numRecs === 0 || numRatios === 0) malformed("compressed table must contain at least one group and ratio");
	const headerEnd = 6 + numRatios * 6;
	ensureRange(6, numRatios * 4, data.length, "ratio records");
	input.seekAbsolute(6 + numRatios * 4);
	const offsets = [];
	for (let i = 0; i < numRatios; i++) offsets.push(input.readU16());
	const groupStarts = [...new Set(offsets)].sort((a, b) => a - b);
	if (groupStarts.length !== numRecs) malformed(`ratio offsets identify ${groupStarts.length} groups, header declares ${numRecs}`);
	if (groupStarts[0] !== offsets[0]) malformed("the first ratio offset must point to the first compressed group");
	for (const offset of groupStarts) if (offset < headerEnd) malformed("group offset overlaps the header");
	input.seekAbsolute(offsets[0]);
	let output = data.slice();
	for (let groupIndex = 0; groupIndex < numRecs; groupIndex++) {
		const compressedStart = input.pos;
		const recs = input.readU16();
		const yMaxMultiplier = input.readS16();
		const yMinMultiplier = input.readS16();
		if (recs === 0) malformed(`group ${groupIndex} has no records`);
		const expandedSize = 4 + recs * 6;
		const groupStart = groupStarts[groupIndex];
		const groupLimit = groupStarts[groupIndex + 1] ?? data.length;
		if (groupIndex + 1 < numRecs && groupStart + expandedSize > groupLimit) malformed(`expanded group ${groupIndex} overlaps the next group`);
		const records = new Stream(null, 0);
		records.reserve(recs * 6);
		let predictedPpem = 8;
		let previousPpem = -1;
		let startSize = 0;
		let endSize = 0;
		for (let i = 0; i < recs; i++) {
			const ppemError = readMagnitude(input);
			const yMaxError = readMagnitude(input);
			const yMinError = readMagnitude(input);
			const ppem = ppemError + predictedPpem;
			if (!Number.isInteger(ppem) || ppem < 0 || ppem > 65535 || ppem <= previousPpem) malformed(`group ${groupIndex} has an invalid or unsorted ppem`);
			const predictedYMax = Math.trunc((ppem * yMaxMultiplier + 1024) / 2048);
			const predictedYMin = -Math.trunc((ppem * yMinMultiplier + 1024) / 2048);
			const yMax = toInt16$1(predictedYMax + yMaxError, `group ${groupIndex} yMax`);
			const yMin = toInt16$1(predictedYMin + yMinError, `group ${groupIndex} yMin`);
			if (i === 0) startSize = ppem;
			if (i === recs - 1) endSize = ppem;
			records.writeU16(ppem);
			records.writeS16(yMax);
			records.writeS16(yMin);
			previousPpem = ppem;
			predictedPpem = ppem + 1;
		}
		if (input.bitPos !== 0) {
			input.pos++;
			input.bitPos = 0;
		}
		ensureRange(compressedStart, input.pos - compressedStart, data.length, `compressed group ${groupIndex}`);
		const outputGroup = new Stream(null, 0);
		outputGroup.reserve(expandedSize);
		outputGroup.writeU16(recs);
		outputGroup.writeU8(startSize & 255);
		outputGroup.writeU8(endSize & 255);
		for (const byte of records.toUint8Array()) outputGroup.writeU8(byte);
		const groupEnd = groupStart + expandedSize;
		if (groupEnd > output.length) {
			const expanded = new Uint8Array(groupEnd);
			expanded.set(output);
			output = expanded;
		}
		output.set(outputGroup.toUint8Array(), groupStart);
	}
	validateUncompressed(output);
	return output;
}
//#endregion
//#region src/ctf-parser.ts
/**
* CTF (Compact TrueType Font) parser — reconstructs a TrueType font from
* three decompressed CTF streams produced by LZCOMP decompression.
*
* Ported from libeot (MPL 2.0) — parseCTF.c
*
* @see http://www.w3.org/Submission/MTX/
*/
const FLG_ON_CURVE = 1;
const FLG_X_SHORT = 2;
const FLG_Y_SHORT = 4;
const FLG_X_SAME = 16;
const FLG_Y_SAME = 32;
const NPUSHB = 64;
const NPUSHW = 65;
const PUSHB = 176;
const PUSHW = 184;
const ARG_1_AND_2_ARE_WORDS = 1;
const HAVE_SCALE = 8;
const MORE_COMPONENTS = 32;
const HAVE_XY_SCALE = 64;
const HAVE_2_BY_2 = 128;
const HAVE_INSTRUCTIONS = 256;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
/** Wrap a value into signed 16-bit range. */
function toInt16(v) {
	v &= 65535;
	return v >= 32768 ? v - 65536 : v;
}
/**
* Read a 255UShort value from the stream.
*
* Encoding:
*  - 253: next two bytes form a big-endian U16
*  - 255: 253 + next U8
*  - 254: 506 + next U8
*  - else: literal value
*/
function read255UShort(s) {
	const code = s.readU8();
	if (code === 253) return s.readU16();
	if (code === 255) return 253 + s.readU8();
	if (code === 254) return 506 + s.readU8();
	return code;
}
/**
* Read a 255Short value from the stream.
*
* Encoding:
*  - 253: next two bytes form a big-endian S16
*  - 250: negate sign, then re-read next code
*  - 255: 250 + next U8
*  - 254: 500 + next U8
*  - else: literal value
*
* The final result is multiplied by the accumulated sign.
*/
function read255Short(s) {
	let sign = 1;
	let code = s.readU8();
	if (code === 253) return s.readS16();
	if (code === 250) {
		sign = -1;
		code = s.readU8();
	}
	let value;
	if (code === 255) value = 250 + s.readU8();
	else if (code === 254) value = 500 + s.readU8();
	else value = code;
	return value * sign;
}
/**
* Decode a delta-encoded CVT (Control Value Table).
*
* Each entry is a signed delta added to a running accumulator and written
* as a big-endian S16 into the output buffer.
*/
function unpackCVT(table, sIn) {
	sIn.seekAbsolute(table.offset);
	const numEntries = sIn.readU16();
	const out = new Stream(null, 0);
	out.reserve(numEntries * 2);
	let lastValue = 0;
	for (let i = 0; i < numEntries; i++) {
		const code = sIn.readU8();
		let val;
		if (code >= 248) val = 238 * (code - 247) + sIn.readU8();
		else if (code >= 239) val = -(238 * (code - 239) + sIn.readU8());
		else if (code === 238) val = sIn.readS16();
		else val = code;
		lastValue = toInt16(lastValue + val);
		out.writeS16(lastValue);
	}
	table.buf = out.toUint8Array();
	table.bufSize = table.buf.length;
}
/**
* Decode hop-coded push data from the instruction stream and emit standard
* TrueType PUSH instructions to the output stream.
*
* Hop codes allow compact representation of alternating patterns:
*  - 0xFB (hop3): `A B → A B A C A`   (consumes 3 more from remaining)
*  - 0xFC (hop4): `A B → A B A C A D A` (consumes 5 more from remaining)
*  - default: read 255Short, consumes 1 from remaining
*
* Values are flushed with the appropriate PUSH opcode when the type changes
* (BYTE vs SHORT) or the accumulated count reaches 255.
*/
function decodePushInstructions(sIn, sOut, pushCount) {
	if (pushCount === 0) return;
	let decoded = 0;
	let last = 0;
	let secondLast = 0;
	let remaining = pushCount;
	let isShort = false;
	const runValues = [];
	/** Flush accumulated run values with the appropriate PUSH opcode. */
	function flush() {
		if (runValues.length === 0) return;
		const count = runValues.length;
		if (isShort) {
			if (count < 8) sOut.writeU8(PUSHW + (count - 1));
			else {
				sOut.writeU8(NPUSHW);
				sOut.writeU8(count);
			}
			for (const v of runValues) sOut.writeS16(v);
		} else {
			if (count < 8) sOut.writeU8(PUSHB + (count - 1));
			else {
				sOut.writeU8(NPUSHB);
				sOut.writeU8(count);
			}
			for (const v of runValues) sOut.writeU8(v & 255);
		}
		runValues.length = 0;
	}
	/** Add a single value to the run, flushing on type change or overflow. */
	function put(v) {
		secondLast = last;
		last = v;
		decoded++;
		const needsShort = v < 0 || v > 255;
		if (runValues.length > 0 && needsShort !== isShort) flush();
		if (runValues.length === 0) isShort = needsShort;
		runValues.push(v);
		if (runValues.length >= 255) flush();
	}
	while (remaining > 0) {
		const code = sIn.peekU8();
		if (code === 251) {
			if (remaining < 3 || decoded < 2) throw new EotError("CORRUPT_HOPCODE_DATA", `corrupt hop3 (0xFB) push data: remaining=${remaining}, decoded=${decoded}`);
			sIn.readU8();
			const prev = secondLast;
			put(prev);
			put(read255Short(sIn));
			put(prev);
			remaining -= 3;
		} else if (code === 252) {
			if (remaining < 5 || decoded < 2) throw new EotError("CORRUPT_HOPCODE_DATA", `corrupt hop4 (0xFC) push data: remaining=${remaining}, decoded=${decoded}`);
			sIn.readU8();
			const prev = secondLast;
			put(prev);
			put(read255Short(sIn));
			put(prev);
			put(read255Short(sIn));
			put(prev);
			remaining -= 5;
		} else {
			put(read255Short(sIn));
			remaining -= 1;
		}
	}
	flush();
}
/**
* Build the TrueType flag byte for a single point.
*
* @param x         X coordinate delta.
* @param y         Y coordinate delta.
* @param onCurve   Whether the point is on the curve.
* @param firstTime Whether this is the very first point in the glyph (always
*                  write the coordinate even if it is zero).
*/
function makeGlyphFlags(x, y, onCurve, firstTime) {
	let flags = 0;
	if (onCurve) flags |= FLG_ON_CURVE;
	if (!firstTime && x === 0) flags |= FLG_X_SAME;
	else if (x > -256 && x < 0) flags |= FLG_X_SHORT;
	else if (x >= 0 && x < 256) flags |= 18;
	if (!firstTime && y === 0) flags |= FLG_Y_SAME;
	else if (y > -256 && y < 0) flags |= FLG_Y_SHORT;
	else if (y >= 0 && y < 256) flags |= 36;
	return flags;
}
/**
* Decode a simple glyph from the three CTF streams and write standard
* TrueType glyph data to `out`.
*
* @param numContours  Number of contours (positive).
* @param streams      The three CTF streams:
*                       [0] = glyph / coordinate data,
*                       [1] = push instruction data,
*                       [2] = hinting code data.
* @param out          Output stream receiving TrueType glyph bytes.
* @param calcBBox     If true, compute the bounding box from point data.
* @param minX/minY/maxX/maxY  Explicit bbox values used when calcBBox=false.
*/
function decodeSimpleGlyph(numContours, streams, out, calcBBox, minX, minY, maxX, maxY) {
	if (numContours === 0) return;
	const sGlyph = streams[0];
	out.writeS16(numContours);
	const bboxPos = out.pos;
	if (calcBBox) {
		minX = INT16_MAX;
		minY = INT16_MAX;
		maxX = INT16_MIN;
		maxY = INT16_MIN;
		out.writeS16(0);
		out.writeS16(0);
		out.writeS16(0);
		out.writeS16(0);
	} else {
		out.writeS16(minX);
		out.writeS16(minY);
		out.writeS16(maxX);
		out.writeS16(maxY);
	}
	let totalPoints = 0;
	for (let c = 0; c < numContours; c++) {
		if (c === 0) totalPoints = 1;
		const pointsInContour = read255UShort(sGlyph);
		totalPoints += pointsInContour;
		out.writeU16(totalPoints - 1);
	}
	if (totalPoints > 65535 || totalPoints > sGlyph.size - sGlyph.pos) throw new EotError("CORRUPT_FILE", `glyph declares implausible point count ${totalPoints}`);
	const flagBytes = sGlyph.buf.subarray(sGlyph.pos, sGlyph.pos + totalPoints);
	sGlyph.pos += totalPoints;
	const xDeltas = new Int16Array(totalPoints);
	const yDeltas = new Int16Array(totalPoints);
	let cumulativeX = 0;
	let cumulativeY = 0;
	const gBuf = sGlyph.buf;
	const gSize = sGlyph.size;
	let gPos = sGlyph.pos;
	for (let i = 0; i < totalPoints; i++) {
		const enc = TRIPLET_ENCODINGS[flagBytes[i] & 127];
		const n = enc.byteCount - 1;
		if (gPos + n > gSize) {
			sGlyph.pos = gPos;
			throw new EotError("INSUFFICIENT_BYTES", "Stream: not enough data for bit read");
		}
		let raw = 0;
		for (let k = 0; k < n; k++) raw = raw << 8 | gBuf[gPos++];
		const yBits = enc.yBits;
		const rawX = raw >>> yBits;
		const rawY = raw & (1 << yBits) - 1;
		let dx = rawX + enc.deltaX;
		let dy = rawY + enc.deltaY;
		if (enc.xSign !== 0) dx *= enc.xSign;
		if (enc.ySign !== 0) dy *= enc.ySign;
		xDeltas[i] = dx;
		yDeltas[i] = dy;
		cumulativeX += xDeltas[i];
		cumulativeY += yDeltas[i];
		if (calcBBox) {
			if (cumulativeX < minX) minX = cumulativeX;
			if (cumulativeX > maxX) maxX = cumulativeX;
			if (cumulativeY < minY) minY = cumulativeY;
			if (cumulativeY > maxY) maxY = cumulativeY;
		}
	}
	sGlyph.pos = gPos;
	const codeSizeLocation = out.pos;
	out.writeU16(0);
	const pushCount = read255UShort(sGlyph);
	decodePushInstructions(streams[1], out, pushCount);
	const codeSize = read255UShort(sGlyph);
	if (codeSize > 0) {
		out.reserve(out.pos + codeSize);
		streams[2].copyTo(out, codeSize);
	}
	const unpackedCodeSize = out.pos - (codeSizeLocation + 2);
	const savedPos = out.pos;
	out.seekAbsolute(codeSizeLocation);
	out.writeU16(unpackedCodeSize);
	out.seekAbsolute(savedPos);
	out.reserve(out.pos + 5 * totalPoints);
	const oBuf = out.buf;
	let o = out.pos;
	for (let i = 0; i < totalPoints; i++) {
		const onCurve = (flagBytes[i] & 128) === 0;
		oBuf[o++] = makeGlyphFlags(xDeltas[i], yDeltas[i], onCurve, i === 0);
	}
	for (let i = 0; i < totalPoints; i++) {
		const x = xDeltas[i];
		if (i === 0 || x !== 0) {
			if (x > -256 && x < 256) oBuf[o++] = x < 0 ? -x : x;
			else {
				oBuf[o++] = x >> 8 & 255;
				oBuf[o++] = x & 255;
			}
		}
	}
	for (let i = 0; i < totalPoints; i++) {
		const y = yDeltas[i];
		if (i === 0 || y !== 0) {
			if (y > -256 && y < 256) oBuf[o++] = y < 0 ? -y : y;
			else {
				oBuf[o++] = y >> 8 & 255;
				oBuf[o++] = y & 255;
			}
		}
	}
	out.pos = o;
	if (o > out.size) out.size = o;
	if (calcBBox) {
		const endPos = out.pos;
		out.seekAbsolute(bboxPos);
		out.writeS16(minX);
		out.writeS16(minY);
		out.writeS16(maxX);
		out.writeS16(maxY);
		out.seekAbsolute(endPos);
	}
}
/**
* Decode a composite glyph from the CTF streams.
*
* Composite glyphs reference other glyphs via component records. Each
* component specifies a glyph index, positioning arguments, and optional
* transformation matrices.
*/
function decodeCompositeGlyph(streams, out) {
	const sGlyph = streams[0];
	out.writeS16(-1);
	out.writeS16(sGlyph.readS16());
	out.writeS16(sGlyph.readS16());
	out.writeS16(sGlyph.readS16());
	out.writeS16(sGlyph.readS16());
	let flags = 0;
	do {
		flags = sGlyph.readU16();
		const glyphIndex = sGlyph.readU16();
		out.writeU16(flags);
		out.writeU16(glyphIndex);
		let argBytes;
		if (flags & ARG_1_AND_2_ARE_WORDS) argBytes = 4;
		else argBytes = 2;
		out.reserve(out.pos + argBytes + 8);
		sGlyph.copyTo(out, argBytes);
		let transformBytes = 0;
		if (flags & HAVE_2_BY_2) transformBytes = 8;
		else if (flags & HAVE_XY_SCALE) transformBytes = 4;
		else if (flags & HAVE_SCALE) transformBytes = 2;
		if (transformBytes > 0) sGlyph.copyTo(out, transformBytes);
	} while (flags & MORE_COMPONENTS);
	if (flags & HAVE_INSTRUCTIONS) {
		const numInstrPos = out.pos;
		out.writeU16(0);
		const pushCount = read255UShort(sGlyph);
		decodePushInstructions(streams[1], out, pushCount);
		const codeSize = read255UShort(sGlyph);
		if (codeSize > 0) {
			out.reserve(out.pos + codeSize);
			streams[2].copyTo(out, codeSize);
		}
		const numInstr = out.pos - (numInstrPos + 2);
		const savedPos = out.pos;
		out.seekAbsolute(numInstrPos);
		out.writeU16(numInstr);
		out.seekAbsolute(savedPos);
	}
}
/**
* Decode a single glyph from the CTF streams.
*
* The first value read is `numContours`:
*  - Negative: composite glyph
*  - 0x7FFF:  simple glyph with explicit bbox and actual contour count
*  - Other:   simple glyph with computed bbox
*/
function decodeGlyph(streams, out) {
	const numContours = streams[0].readS16();
	if (numContours < 0) decodeCompositeGlyph(streams, out);
	else if (numContours === 32767) decodeSimpleGlyph(streams[0].readS16(), streams, out, false, streams[0].readS16(), streams[0].readS16(), streams[0].readS16(), streams[0].readS16());
	else decodeSimpleGlyph(numContours, streams, out, true, 0, 0, 0, 0);
}
/**
* Iterate over every glyph, decode it, and build the `glyf` and `loca`
* tables.
*
* @param glyf      The glyf table descriptor (output buf/bufSize are set).
* @param loca      The loca table descriptor (output buf/bufSize are set).
* @param headData  Parsed `head` table fields.
* @param maxpData  Parsed `maxp` table fields.
* @param streams   The three CTF streams.
*/
function populateGlyfAndLoca(glyf, loca, headData, maxpData, streams) {
	const numGlyphs = maxpData.numGlyphs;
	streams[0].seekAbsolute(glyf.offset);
	streams[1].seekAbsolute(0);
	streams[2].seekAbsolute(0);
	const maxGlyphSize = 10 + 2 * maxpData.maxContours + 2 + maxpData.maxSizeOfInstructions + 256 + 5 * maxpData.maxPoints + 4 * maxpData.maxComponentElements * 6 + 256;
	const outStream = new Stream(null, 0);
	outStream.reserve(Math.min(numGlyphs * 256, 2 * (streams[0].size - streams[0].pos) + 4 * streams[1].size + streams[2].size + 2 * numGlyphs + 256));
	const locaOffsets = [0];
	for (let i = 0; i < numGlyphs; i++) {
		outStream.pos;
		outStream.reserve(outStream.pos + maxGlyphSize);
		decodeGlyph(streams, outStream);
		if (outStream.pos & 1) outStream.writeU8(0);
		locaOffsets.push(outStream.pos);
	}
	const useLongLoca = headData.indexToLocFormat === 1 || outStream.pos > 131070;
	if (useLongLoca && headData.indexToLocFormat === 0) {
		headData.table.buf[50] = 0;
		headData.table.buf[51] = 1;
		headData.indexToLocFormat = 1;
	}
	const locaStream = new Stream(null, 0);
	locaStream.reserve((numGlyphs + 1) * (useLongLoca ? 4 : 2));
	for (const offset of locaOffsets) if (useLongLoca) locaStream.writeU32(offset);
	else locaStream.writeU16(offset / 2);
	glyf.buf = outStream.buf.subarray(0, outStream.size);
	glyf.bufSize = glyf.buf.length;
	loca.buf = locaStream.buf.subarray(0, locaStream.size);
	loca.bufSize = loca.buf.length;
}
/**
* Parse the `head` table to extract `indexToLocFormat`.
*
* `indexToLocFormat` is at byte offset 50 within the `head` table.
*/
function parseHead(table, hasGlyf) {
	if (!hasGlyf) return {
		indexToLocFormat: 0,
		table
	};
	if (table.bufSize < 54 || table.buf.length < 54) throw new EotError("MALFORMED_HEAD_TABLE", `head table too small: ${table.bufSize} bytes (need 54)`);
	const s = new Stream(table.buf, table.bufSize);
	s.seekAbsolute(50);
	const indexToLocFormat = s.readS16();
	if (indexToLocFormat !== 0 && indexToLocFormat !== 1) throw new EotError("MALFORMED_HEAD_TABLE", `invalid head indexToLocFormat: ${indexToLocFormat}`);
	return {
		indexToLocFormat,
		table
	};
}
/**
* Parse the `maxp` table to extract key metrics.
*
* Version 1.0 (0x00010000) layout:
*   offset 0  : version          U32
*   offset 4  : numGlyphs        U16
*   offset 6  : maxPoints         U16
*   offset 8  : maxContours       U16
*   offset 10 : maxCompositePoints U16
*   offset 12 : maxCompositeContours U16
*   offset 14 : maxZones          U16
*   offset 16 : maxTwilightPoints U16
*   offset 18 : maxStorage        U16
*   offset 20 : maxFunctionDefs   U16
*   offset 22 : maxInstructionDefs U16
*   offset 24 : maxStackElements  U16
*   offset 26 : maxSizeOfInstructions U16
*   offset 28 : maxComponentElements  U16
*   ... (remaining fields not needed)
*/
function parseMaxp(table) {
	const s = new Stream(table.buf, table.bufSize);
	const version = s.readU32();
	const numGlyphs = s.readU16();
	let maxPoints = 0;
	let maxContours = 0;
	let maxSizeOfInstructions = 0;
	let maxComponentElements = 0;
	if (version === 65536) {
		maxPoints = s.readU16();
		maxContours = s.readU16();
		s.readU16();
		s.readU16();
		s.readU16();
		s.readU16();
		s.readU16();
		s.readU16();
		s.readU16();
		s.readU16();
		maxSizeOfInstructions = s.readU16();
		maxComponentElements = s.readU16();
	}
	return {
		numGlyphs,
		maxPoints,
		maxContours,
		maxSizeOfInstructions,
		maxComponentElements
	};
}
const SFNT_TRUETYPE = 65536;
const SFNT_OTTO = 1330926671;
const SFNT_TRUE = 1953658213;
/**
* The sfnt version for the rebuilt font. It follows the outlines actually
* present rather than trusting the header alone: a font whose outlines are a
* CFF table must say 'OTTO', or strict rasterisers (Apple CoreText) reject
* it, and one with `glyf` outlines must not say 'OTTO'.
*/
function resolveScalarType(header, cffOutlines) {
	if (cffOutlines) return SFNT_OTTO;
	return header === SFNT_TRUE ? SFNT_TRUE : SFNT_TRUETYPE;
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
function parseCTF(streams, options) {
	const s0 = streams[0];
	const headerScalarType = s0.readU32();
	const numTables = s0.readU16();
	s0.readU16();
	s0.readU16();
	s0.readU16();
	const tables = [];
	let glyfIdx = -1;
	let locaIdx = -1;
	let maxpIdx = -1;
	let headIdx = -1;
	let hmtxIdx = -1;
	for (let i = 0; i < numTables; i++) {
		const tag = s0.readChar() + s0.readChar() + s0.readChar() + s0.readChar();
		s0.seekRelative(4);
		const table = {
			tag,
			offset: s0.readU32(),
			bufSize: s0.readU32(),
			buf: /* @__PURE__ */ new Uint8Array(0),
			checksum: 0
		};
		const idx = tables.length;
		tables.push(table);
		if (tag === "glyf") glyfIdx = idx;
		else if (tag === "loca") locaIdx = idx;
		else if (tag === "maxp") maxpIdx = idx;
		else if (tag === "head") headIdx = idx;
		else if (tag === "hmtx") hmtxIdx = idx;
		else if (tag === "cvt ") {}
	}
	for (let i = 0; i < tables.length; i++) {
		const table = tables[i];
		if (table.tag === "glyf" || table.tag === "loca") continue;
		if (table.tag === "cvt ") {
			unpackCVT(table, s0);
			continue;
		}
		s0.seekAbsolute(table.offset);
		if (table.bufSize > s0.size - table.offset) throw new EotError("INSUFFICIENT_BYTES", `truncated ${table.tag} table`);
		table.buf = s0.buf.slice(table.offset, table.offset + table.bufSize);
		if (table.tag === "head") {
			if (table.bufSize < 12) throw new EotError("MALFORMED_HEAD_TABLE", `head table too small: ${table.bufSize} bytes (need at least 12)`);
			table.buf[8] = 0;
			table.buf[9] = 0;
			table.buf[10] = 0;
			table.buf[11] = 0;
		}
	}
	if (maxpIdx < 0) throw new EotError("NO_MAXP_TABLE", "CTF font is missing a maxp table");
	if (headIdx < 0) throw new EotError("NO_HEAD_TABLE", "CTF font is missing a head table");
	if (hmtxIdx < 0) throw new EotError("NO_HMTX_TABLE", "CTF font is missing an hmtx table");
	const headData = parseHead(tables[headIdx], glyfIdx >= 0);
	const maxpData = parseMaxp(tables[maxpIdx]);
	const maxpVersion = new DataView(tables[maxpIdx].buf.buffer, tables[maxpIdx].buf.byteOffset, tables[maxpIdx].buf.byteLength).getUint32(0);
	const cffOutlines = tables.some((t) => t.tag === "CFF " || t.tag === "CFF2") && glyfIdx < 0;
	if (maxpVersion !== 65536 && !cffOutlines) emitWarning(options, "WARN_MAXP_VERSION", `maxp version 0x${maxpVersion.toString(16)} is not 1.0; MTX carries TrueType outlines, glyph limits were not read`);
	for (const tag of [
		"hhea",
		"cmap",
		"post",
		"name",
		"OS/2"
	]) if (!tables.some((t) => t.tag === tag)) emitWarning(options, "WARN_MISSING_TABLE", `CTF font has no ${tag} table; the reconstructed font may be unusable in some renderers`);
	for (const table of tables) if (table.tag === "VDMX") {
		table.buf = decodeVdmx(table.buf);
		table.bufSize = table.buf.length;
	} else if (table.tag === "hdmx") {
		if ((table.buf.length >= 2 ? table.buf[0] << 8 | table.buf[1] : -1) === 0) {
			const hhea = tables.find((candidate) => candidate.tag === "hhea");
			if (!hhea || hhea.buf.length < 36) throw new EotError("CORRUPT_FILE", "compressed hdmx requires a complete hhea table");
			const head = tables[headIdx].buf;
			table.buf = decodeHdmx(table.buf, {
				numGlyphs: maxpData.numGlyphs,
				unitsPerEm: head[18] << 8 | head[19],
				numberOfHMetrics: hhea.buf[34] << 8 | hhea.buf[35],
				hmtx: tables[hmtxIdx].buf
			});
		} else table.buf = decodeHdmx(table.buf);
		table.bufSize = table.buf.length;
	}
	if (glyfIdx >= 0) {
		if (locaIdx < 0) {
			const locaTable = {
				tag: "loca",
				offset: 0,
				bufSize: 0,
				buf: /* @__PURE__ */ new Uint8Array(0),
				checksum: 0
			};
			locaIdx = tables.length;
			tables.push(locaTable);
		}
		populateGlyfAndLoca(tables[glyfIdx], tables[locaIdx], headData, maxpData, streams);
	}
	return {
		tables,
		scalarType: resolveScalarType(headerScalarType, cffOutlines)
	};
}
//#endregion
//#region src/ahuff.ts
/**
* Return the number of bits required to represent the non-negative integer `x`.
* Equivalent to floor(log2(x)) + 1 for x > 0.
*
* libeot's `BitsUsed(0)` returns 1 (its mask cascade falls through to the low
* bit); we match that so the function is a faithful port. In practice this
* module only ever calls it with x > 0, so the zero case is defensive.
*/
function bitsUsed(x) {
	if (x <= 0) return 1;
	return 32 - Math.clz32(x);
}
var AHuff = class AHuff {
	bio;
	range;
	up;
	child;
	code;
	weight;
	/** Maps symbol value -> current tree index of its leaf node. */
	symbolIndex;
	/** Number of bits that encode a "full-size" symbol (ceil(log2(range))). */
	bitCount;
	/**
	* Secondary bit width used for large-range trees.
	* 0 when range <= 256 (small tree path).
	*/
	bitCount2;
	static ROOT = 1;
	constructor(bio, range) {
		this.bio = bio;
		this.range = range;
		this.bitCount = bitsUsed(range - 1);
		this.bitCount2 = 0;
		if (range > 256 && range < 512) this.bitCount2 = bitsUsed(range - 256 - 1) + 1;
		const treeSize = 2 * range;
		const up = this.up = new Int32Array(treeSize);
		const child = this.child = new Int32Array(2 * treeSize);
		const code = this.code = new Int32Array(treeSize).fill(-1);
		this.weight = new Int32Array(treeSize);
		for (let i = 2; i < treeSize; i++) {
			up[i] = i >> 1;
			this.weight[i] = 1;
		}
		for (let i = 1; i < range; i++) {
			child[2 * i] = 2 * i;
			child[2 * i + 1] = 2 * i + 1;
		}
		this.symbolIndex = new Int32Array(range);
		for (let i = 0; i < range; i++) {
			const leafIdx = range + i;
			code[leafIdx] = i;
			child[2 * leafIdx] = -1;
			child[2 * leafIdx + 1] = -1;
			this.symbolIndex[i] = leafIdx;
		}
		this.initWeight(AHuff.ROOT);
		if (this.bitCount2 !== 0) {
			this.updateWeight(this.symbolIndex[256]);
			this.updateWeight(this.symbolIndex[257]);
			const dup2Sym = range - 3;
			for (let i = 0; i < 12; i++) this.updateWeight(this.symbolIndex[dup2Sym]);
			const dup4Sym = range - 2;
			for (let i = 0; i < 6; i++) this.updateWeight(this.symbolIndex[dup4Sym]);
		} else for (let j = 0; j < 2; j++) for (let i = 0; i < range; i++) this.updateWeight(this.symbolIndex[i]);
	}
	/**
	* Decode one symbol from the bit stream.
	*
	* Starting at ROOT, read one bit at a time:
	*   - 0 → go left
	*   - 1 → go right
	* Continue until a leaf (code >= 0) is reached.  Then update the
	* tree weights and return the symbol code.
	*/
	readSymbol() {
		const bio = this.bio;
		const code = this.code;
		const child = this.child;
		let a = AHuff.ROOT;
		let symbol;
		const data = bio.data;
		const size = bio.size;
		let index = bio.index;
		let byte = bio.bitBuffer;
		let count = bio.bitCount;
		do {
			if (count === 0) {
				if (index >= size) {
					bio.index = index;
					bio.bitBuffer = byte;
					bio.bitCount = 0;
					throw new EotError("INSUFFICIENT_BYTES", "BitIO: end of data");
				}
				byte = data[index++];
				count = 8;
			}
			a = child[a << 1 | byte >> --count & 1];
			symbol = code[a];
		} while (symbol < 0);
		bio.index = index;
		bio.bitBuffer = byte;
		bio.bitCount = count;
		this.updateWeight(a);
		return symbol;
	}
	/**
	* Increment the weight of node `a` and propagate up to ROOT, swapping
	* nodes as necessary to maintain the sibling property (nodes in
	* non-increasing weight order by index). For each node below ROOT: if its
	* predecessor has the same weight, scan back to the first node with that
	* weight and swap with it (unless that is ROOT), then bump the weight and
	* move to the parent. Finally ROOT's weight is incremented.
	*/
	updateWeight(a) {
		const weight = this.weight;
		const up = this.up;
		for (; a !== AHuff.ROOT; a = up[a]) {
			const weightA = weight[a];
			let b = a - 1;
			if (weight[b] === weightA) {
				do
					b--;
				while (weight[b] === weightA);
				b++;
				if (b > AHuff.ROOT) {
					this.swapNodes(a, b);
					a = b;
				}
			}
			weight[a] = weightA + 1;
		}
		weight[AHuff.ROOT]++;
	}
	/**
	* Swap the content (children, code, weight) of two nodes. The `up`
	* pointer stays with the position, so afterwards the children of each
	* swapped internal node get their parent pointer fixed, and leaves get
	* their `symbolIndex` entry updated.
	*/
	swapNodes(a, b) {
		const { child, code, weight, up } = this;
		const a2 = a << 1;
		const b2 = b << 1;
		let t = child[a2];
		child[a2] = child[b2];
		child[b2] = t;
		t = child[a2 + 1];
		child[a2 + 1] = child[b2 + 1];
		child[b2 + 1] = t;
		t = code[a];
		code[a] = code[b];
		code[b] = t;
		t = weight[a];
		weight[a] = weight[b];
		weight[b] = t;
		let c = code[a];
		if (c < 0) {
			up[child[a2]] = a;
			up[child[a2 + 1]] = a;
		} else this.symbolIndex[c] = a;
		c = code[b];
		if (c < 0) {
			up[child[b2]] = b;
			up[child[b2 + 1]] = b;
		} else this.symbolIndex[c] = b;
	}
	/**
	* Recursively compute weights for internal nodes after the initial
	* tree construction.  Leaf weights are already set to 1.
	*
	* weight(internal) = weight(left) + weight(right)
	*/
	initWeight(a) {
		if (this.code[a] >= 0) return this.weight[a];
		return this.weight[a] = this.initWeight(this.child[2 * a]) + this.initWeight(this.child[2 * a + 1]);
	}
};
//#endregion
//#region src/bitio.ts
/**
* BitIO - MSB-first bit-level reader from a Uint8Array buffer.
*
* Ported from libeot (MPL 2.0) MTX_BITIO implementation.
*
* The reader maintains a single-byte shift register (`bitBuffer`).
* Bits are consumed most-significant-bit first.  When all bits in the
* current byte have been shifted out, the next byte is loaded
* automatically.
*/
var BitIO = class {
	/** @internal */ data;
	/** @internal */ index;
	/** @internal */ size;
	/** @internal Current byte being consumed. */ bitBuffer = 0;
	/** @internal Bits of `bitBuffer` not yet consumed (0..8). */ bitCount = 0;
	/**
	* @param data   Source byte buffer.
	* @param offset Starting byte offset into `data`.
	* @param size   Absolute end index into `data` (exclusive) — reading stops
	*               once `index` reaches it. Defaults to `data.length`. Clamped
	*               to `data.length` so an over-large value cannot read past the
	*               end of the buffer and silently yield zero bits.
	*/
	constructor(data, offset = 0, size) {
		this.data = data;
		this.index = offset;
		this.size = Math.min(size ?? data.length, data.length);
	}
	/**
	* Read a single bit from the stream.
	*
	* Mirrors `MTX_BITIO_input_bit`:
	*   - If `bitCount` has reached 0, load the next byte into `bitBuffer`
	*     and reset `bitCount` to 7.
	*   - Shift `bitBuffer` left by 1.
	*   - Return whether bit 8 (0x100) is set (i.e. the MSB that was
	*     shifted out of the original byte value).
	*/
	inputBit() {
		return this.nextBit() !== 0;
	}
	/** Same as {@link inputBit} but returns 0 | 1 (hot-path variant). */
	nextBit() {
		if (this.bitCount === 0) {
			if (this.index >= this.size) throw new EotError("INSUFFICIENT_BYTES", "BitIO: end of data");
			this.bitBuffer = this.data[this.index++];
			this.bitCount = 8;
		}
		return this.bitBuffer >> --this.bitCount & 1;
	}
	/**
	* Read an unsigned integer of `numberOfBits` width, MSB first.
	*
	* Mirrors `MTX_BITIO_ReadValue`: accumulates bits from the most
	* significant down to the least significant.
	*/
	readValue(numberOfBits) {
		let value = 0;
		for (let i = numberOfBits - 1; i >= 0; i--) value = value << 1 | this.nextBit();
		return value >>> 0;
	}
};
//#endregion
//#region src/lzcomp.ts
/**
* LZCOMP decompression module for MicroType Express (MTX) fonts.
* Ported from libeot (MPL 2.0) — lzcomp.c
*
* Implements LZCOMP sliding-window decompression with optional
* run-length decoding on the output stream.
*/
/** Number of bits used for each length chunk (excluding the stop bit). */
const LEN_WIDTH = 3;
/** Number of bits used for each distance chunk. */
const DIST_WIDTH = 3;
/** Number of data bits per length chunk (LEN_WIDTH − 1). */
const BIT_RANGE = 2;
/** Distances >= this threshold add 1 to the decoded length. */
const MAX_2BYTE_DIST = 512;
/**
* Size (in bytes) of the deterministic preload written into the sliding
* window before decompression begins: 2 * 32 * 96 + 4 * 256 = 7168.
*/
const PRELOAD_SIZE = 7168;
/** Minimum match length returned by decodeLength. */
const LEN_MIN = 2;
/** Minimum match distance returned by decodeDistance. */
const DIST_MIN = 1;
/**
* Hard cap on the declared LZCOMP output length. The `out_len` header field is
* 24 bits wide (see `readValue(24)` below), so 2^24 - 1 is the largest value an
* encoder can legally emit; anything above that is corrupt input, not a large
* font. Capping lower would reject legitimate fonts (e.g. large CJK glyph
* streams that exceed a few MiB uncompressed).
*/
const MAX_OUT_LEN = (1 << 24) - 1;
/**
* Hard cap on RLE-expanded output growth. RLE can legally expand up to 255:1
* per escape triple, so the expanded stream can exceed the declared `out_len`.
* Bound it a small multiple above the 24-bit maximum to stop a hostile stream
* from growing the buffer without limit while still admitting real fonts.
*/
const MAX_OUT = 67108864;
/** Message prefix of the error raised when output would exceed the budget. */
const OUTPUT_BUDGET_EXCEEDED = "LZCOMP output exceeds maximum size budget";
const RLE_INITIAL = 0;
const RLE_NORMAL = 1;
const RLE_SEEN_ESCAPE = 2;
const RLE_NEED_BYTE = 3;
/**
* Compute the number of distance ranges and the special-symbol indices
* that depend on the total output length.
*/
function setDistRange(length) {
	let numDistRanges = 1;
	let distMax = DIST_MIN + ((1 << DIST_WIDTH * numDistRanges) - 1);
	while (distMax < length) {
		numDistRanges++;
		if (numDistRanges > 8) throw new EotError("MTX_ERROR", "LZCOMP setDistRange: numDistRanges exceeds bound (8)");
		distMax = DIST_MIN + ((1 << DIST_WIDTH * numDistRanges) - 1);
	}
	const DUP2 = 256 + 8 * numDistRanges;
	const DUP4 = DUP2 + 1;
	const DUP6 = DUP4 + 1;
	const NUM_SYMS = DUP6 + 1;
	return {
		numDistRanges,
		distMax,
		DUP2,
		DUP4,
		DUP6,
		NUM_SYMS
	};
}
/**
* Pre-load the sliding window with deterministic data so that
* early back-references can match known patterns.
*/
function initializeModel(window) {
	let i = 0;
	for (let k = 0; k < 32; k++) for (let j = 0; j < 96; j++) {
		window[i++] = k;
		window[i++] = j;
	}
	let j = 0;
	while (i < PRELOAD_SIZE && j < 256) {
		window[i++] = j;
		window[i++] = j;
		window[i++] = j;
		window[i++] = j;
		j++;
	}
}
/**
* Decode a match length using a stop-bit scheme.
*
* Each chunk contributes `BIT_RANGE` (2) data bits.  Bit 2 of each chunk
* is the *continuation* bit:
*   - bit 2 SET   (1) → more chunks follow
*   - bit 2 CLEAR (0) → this is the last chunk
*
* The first chunk is derived from the already-decoded main symbol; any
* subsequent chunks are read from `lenEcoder`.
*
* @param lenEcoder   Adaptive Huffman tree for length continuation symbols.
* @param symbol      The main symbol that triggered a copy operation (>= 256).
* @param numDistRangesOut  Output parameter — receives the number of distance
*                          ranges for the subsequent distance decode.
* @returns The decoded match length (>= LEN_MIN).
*/
function decodeLength(lenEcoder, symbol) {
	const mask = 4;
	let firstTime = true;
	let value = 0;
	let done;
	let iters = 0;
	do {
		if (++iters > 16) throw new EotError("MTX_ERROR", "LZCOMP decodeLength: iteration cap exceeded");
		let bits;
		if (firstTime) {
			bits = symbol - 256;
			firstTime = false;
			bits &= 7;
		} else bits = lenEcoder.readSymbol();
		done = (bits & mask) === 0;
		bits &= -5;
		value <<= BIT_RANGE;
		value |= bits;
	} while (!done);
	value += LEN_MIN;
	return value;
}
/**
* Decode a match distance by reading `numDistRanges` chunks from the
* distance Huffman tree, each contributing `DIST_WIDTH` (3) bits.
*/
function decodeDistance(distEcoder, numDistRanges) {
	let value = 0;
	for (let i = numDistRanges; i > 0; i--) {
		const bits = distEcoder.readSymbol();
		value <<= DIST_WIDTH;
		value |= bits;
	}
	value += DIST_MIN;
	return value;
}
/**
* Decompress an LZCOMP-compressed byte stream, optionally followed by
* run-length decoding.
*
* @param data     The compressed input bytes.
* @param size     Number of valid bytes in `data`.
* @param version  MTX version flag.  When version !== 1 a leading bit
*                 indicates whether run-length encoding is used on the
*                 output.
* @param maxOut   Optional output budget in bytes. Both the declared length
*                 and RLE-expanded output are rejected once they exceed it,
*                 before the corresponding buffers are allocated or grown.
* @returns The decompressed byte array.
*/
function lzcompDecompress(data, size, version, maxOut = MAX_OUT) {
	const bio = new BitIO(data, 0, size);
	const outCap = Math.min(MAX_OUT, maxOut);
	let usingRunLength;
	if (version === 1) usingRunLength = false;
	else usingRunLength = bio.inputBit();
	const distEcoder = new AHuff(bio, 8);
	const lenEcoder = new AHuff(bio, 8);
	const outLen = bio.readValue(24);
	if (outLen > MAX_OUT_LEN) throw new EotError("MTX_ERROR", `LZCOMP outLen ${outLen} exceeds maximum (${MAX_OUT_LEN})`);
	if (outLen > outCap) throw new EotError("MTX_ERROR", `${OUTPUT_BUDGET_EXCEEDED} (outLen ${outLen} > ${outCap})`);
	const { DUP2, DUP4, DUP6, NUM_SYMS } = setDistRange(outLen);
	const symEcoder = new AHuff(bio, NUM_SYMS);
	const windowSize = PRELOAD_SIZE + outLen;
	const win = new Uint8Array(windowSize);
	initializeModel(win);
	const base = PRELOAD_SIZE;
	if (!usingRunLength) {
		let p = 0;
		while (p < outLen) {
			const symbol = symEcoder.readSymbol();
			if (symbol < 256) win[base + p++] = symbol;
			else if (symbol === DUP2) {
				win[base + p] = win[base + p - 2];
				p++;
			} else if (symbol === DUP4) {
				win[base + p] = win[base + p - 4];
				p++;
			} else if (symbol === DUP6) {
				win[base + p] = win[base + p - 6];
				p++;
			} else {
				let length = decodeLength(lenEcoder, symbol);
				const distance = decodeDistance(distEcoder, (symbol - 256 >>> LEN_WIDTH) + 1);
				if (distance >= MAX_2BYTE_DIST) length++;
				if (!(length >= 0) || length > outLen - p) throw new EotError("MTX_ERROR", "LZCOMP match length exceeds declared output size");
				let src = base + p - distance - length + 1;
				if (src < 0) throw new EotError("MTX_ERROR", "LZCOMP match reaches before the start of the window");
				let dst = base + p;
				for (const end = dst + length; dst < end;) win[dst++] = win[src++];
				p += length;
			}
		}
		return win.subarray(base, base + outLen);
	}
	let outBuf = new Uint8Array(outLen);
	let outIdx = 0;
	/**
	* Make room for `extra` more output bytes. Grows geometrically, but never
	* past the budget, and only fails when the bytes actually needed exceed it.
	*/
	const ensureOut = (extra) => {
		const needed = outIdx + extra;
		if (needed <= outBuf.length) return;
		if (needed > outCap) throw new EotError("MTX_ERROR", OUTPUT_BUDGET_EXCEEDED);
		const tmp = new Uint8Array(Math.min(outCap, Math.max(needed, outBuf.length + (outBuf.length >>> 1) + 16)));
		tmp.set(outBuf.subarray(0, outIdx));
		outBuf = tmp;
	};
	let rleState = RLE_INITIAL;
	let rleEscape = 0;
	let rleCount = 0;
	/** Emit a single decompressed byte through the inline run-length decoder. */
	const emitByte = (byte) => {
		switch (rleState) {
			case RLE_INITIAL:
				rleEscape = byte;
				rleState = RLE_NORMAL;
				break;
			case RLE_NORMAL:
				if (byte === rleEscape) rleState = RLE_SEEN_ESCAPE;
				else {
					ensureOut(1);
					outBuf[outIdx++] = byte;
				}
				break;
			case RLE_SEEN_ESCAPE:
				rleCount = byte;
				if (rleCount === 0) {
					ensureOut(1);
					outBuf[outIdx++] = rleEscape;
					rleState = RLE_NORMAL;
				} else rleState = RLE_NEED_BYTE;
				break;
			case RLE_NEED_BYTE:
				ensureOut(rleCount);
				outBuf.fill(byte, outIdx, outIdx + rleCount);
				outIdx += rleCount;
				rleState = RLE_NORMAL;
		}
	};
	let pos = 0;
	for (; pos < outLen;) {
		const symbol = symEcoder.readSymbol();
		let value;
		if (symbol < 256) value = symbol;
		else if (symbol === DUP2) value = win[base + pos - 2];
		else if (symbol === DUP4) value = win[base + pos - 4];
		else if (symbol === DUP6) value = win[base + pos - 6];
		else {
			let length = decodeLength(lenEcoder, symbol);
			const distance = decodeDistance(distEcoder, (symbol - 256 >>> LEN_WIDTH) + 1);
			if (distance >= MAX_2BYTE_DIST) length++;
			if (!(length >= 0) || length > outLen - pos) throw new EotError("MTX_ERROR", "LZCOMP match length exceeds declared output size");
			const start = base + pos - distance - length + 1;
			if (start < 0) throw new EotError("MTX_ERROR", "LZCOMP match reaches before the start of the window");
			for (let j = 0; j < length; j++) {
				value = win[start + j];
				win[base + pos] = value;
				pos++;
				emitByte(value);
			}
			continue;
		}
		win[base + pos] = value;
		pos++;
		emitByte(value);
	}
	if (pos !== outLen) throw new EotError("MTX_ERROR", `LZCOMP decode overran output: pos=${pos}, expected=${outLen}`);
	if (rleState === RLE_SEEN_ESCAPE || rleState === RLE_NEED_BYTE) throw new EotError("MTX_ERROR", "LZCOMP run-length data ends inside an escape sequence");
	return outBuf.subarray(0, outIdx);
}
//#endregion
//#region src/sfnt-builder.ts
/** Log2 of the largest power of 2 <= n. */
function lgFloor(n) {
	let ret = 0;
	while (n > 1) {
		n = Math.floor(n / 2);
		ret++;
	}
	return ret;
}
/** Largest power of 2 <= n. */
function maxPow2(n) {
	return 1 << lgFloor(n);
}
/**
* Write the 12-byte SFNT offset (header) table.
*
* Layout (all big-endian):
*   scalarType   U32  — 0x00010000 for TrueType, 'OTTO' for CFF outlines
*   numTables    U16
*   searchRange  U16
*   entrySelector U16
*   rangeShift   U16
*/
function writeOffsetTable(ctr, out) {
	const numTables = ctr.tables.length;
	const searchRange = maxPow2(numTables) * 16;
	const entrySelector = lgFloor(numTables);
	const rangeShift = numTables * 16 - searchRange;
	out.writeU32(ctr.scalarType ?? 65536);
	out.writeU16(numTables);
	out.writeU16(searchRange);
	out.writeU16(entrySelector);
	out.writeU16(rangeShift);
}
/**
* Write the table directory — one 16-byte record per table.
*
* Each record (big-endian):
*   tag       4 bytes (ASCII)
*   checksum  U32
*   offset    U32
*   bufSize   U32
*/
function writeTableDirectory(ctr, out) {
	for (const table of [...ctr.tables].sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)) {
		out.writeU8(table.tag.charCodeAt(0));
		out.writeU8(table.tag.charCodeAt(1));
		out.writeU8(table.tag.charCodeAt(2));
		out.writeU8(table.tag.charCodeAt(3));
		out.writeU32(table.checksum);
		out.writeU32(table.offset);
		out.writeU32(table.bufSize);
	}
}
/**
* Write table data to the output stream while computing its checksum.
*
* The data is treated as a sequence of big-endian U32 values.  If the
* table size is not a multiple of 4 the final chunk is zero-padded.
*
* Side-effects: sets `table.offset` and `table.checksum`.
*/
function writeTableCheckingSum(table, out) {
	table.offset = out.pos;
	const data = table.buf;
	const len = table.bufSize;
	const padded = len + 3 & -4;
	const buf = out.buf;
	const start = out.pos;
	buf.set(data.subarray(0, len), start);
	buf.fill(0, start + len, start + padded);
	if (table.tag === "head") buf.fill(0, start + 8, start + 12);
	let checksum = 0;
	for (let off = start, end = start + padded; off < end; off += 4) {
		const word = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
		checksum = checksum + word >>> 0;
	}
	out.pos = start + padded;
	if (out.pos > out.size) out.size = out.pos;
	table.checksum = checksum;
}
function validateTables(ctr) {
	for (const table of ctr.tables) {
		if (!Number.isInteger(table.bufSize) || table.bufSize < 0 || table.bufSize > table.buf.length) throw new EotError("CORRUPT_FILE", `table ${table.tag} has an invalid buffer size`);
		if (table.tag === "head" && table.bufSize < 12) throw new EotError("MALFORMED_HEAD_TABLE", "head table is too short for checksumAdjustment");
	}
}
/** Size of the table directory: 16 bytes per table. */
function getTableDirectorySize(ctr) {
	return 16 * ctr.tables.length;
}
/** Total bytes required for the assembled font. */
function getRequiredSize(ctr) {
	const offsetTableSize = 12;
	const dirSize = getTableDirectorySize(ctr);
	let tableDataSize = 0;
	for (const table of ctr.tables) tableDataSize += Math.ceil(table.bufSize / 4) * 4;
	return offsetTableSize + dirSize + tableDataSize;
}
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
function dumpContainer(ctr, options) {
	validateTables(ctr);
	const requiredSize = getRequiredSize(ctr);
	const maxOutputBytes = options?.maxOutputBytes;
	if (maxOutputBytes !== void 0 && requiredSize > maxOutputBytes) throw new EotError("MTX_ERROR", `reconstructed font (${requiredSize} bytes) exceeds maxOutputBytes (${maxOutputBytes})`);
	const out = new Stream(new Uint8Array(requiredSize), 0);
	writeOffsetTable(ctr, out);
	const dirOffset = out.pos;
	const dirSize = getTableDirectorySize(ctr);
	out.pos += dirSize;
	let totalChecksum = 0;
	for (const table of ctr.tables) {
		writeTableCheckingSum(table, out);
		totalChecksum = totalChecksum + table.checksum >>> 0;
	}
	let headTable;
	for (const table of ctr.tables) if (table.tag === "head") {
		headTable = table;
		break;
	}
	const afterTables = out.pos;
	out.pos = dirOffset;
	writeTableDirectory(ctr, out);
	const beginningLen = 12 + dirSize;
	let beginningChecksum = 0;
	const buf = out.buf;
	const beginningWords = Math.floor(beginningLen / 4);
	for (let i = 0; i < beginningWords; i++) {
		const off = i * 4;
		const word = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
		beginningChecksum = beginningChecksum + word >>> 0;
	}
	totalChecksum = totalChecksum + beginningChecksum >>> 0;
	if (!headTable) throw new EotError("NO_HEAD_TABLE", "cannot assemble SFNT: container is missing a head table");
	const finalChecksum = 2981146554 - totalChecksum >>> 0;
	const adjOffset = headTable.offset + 8;
	buf[adjOffset] = finalChecksum >>> 24 & 255;
	buf[adjOffset + 1] = finalChecksum >>> 16 & 255;
	buf[adjOffset + 2] = finalChecksum >>> 8 & 255;
	buf[adjOffset + 3] = finalChecksum & 255;
	out.pos = afterTables;
	return out.buf.subarray(0, out.pos);
}
//#endregion
//#region src/mtx-decompress.ts
/**
* Top-level MicroType Express (MTX) decompression pipeline.
* Ported from libeot (MPL 2.0) — writeFontFile.c / liblzcomp.c
*
* Combines LZ decompression, CTF parsing, and SFNT assembly to
* produce a usable TrueType font from compressed MTX / EOT data.
*/
/** XOR key used for MTX encryption. */
const ENCRYPTION_KEY = 80;
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
function unpackMtx(data, size, maxOutputBytes = Infinity) {
	if (data.length < 10) throw new EotError("INSUFFICIENT_BYTES", "MTX data too small: header requires at least 10 bytes");
	if (!Number.isInteger(size)) throw new EotError("MTX_ERROR", `MTX data size must be an integer: size=${size}`);
	if (size < 10) throw new EotError("INSUFFICIENT_BYTES", "MTX data too small: header requires at least 10 bytes");
	if (size > data.length) throw new EotError("INSUFFICIENT_BYTES", `MTX data size exceeds the input buffer: size=${size}, data.length=${data.length}`);
	const versionMagic = data[0];
	const offset2 = data[4] << 16 | data[5] << 8 | data[6];
	const offset3 = data[7] << 16 | data[8] << 8 | data[9];
	if (offset2 < 10 || offset3 < offset2 || offset3 > size) throw new EotError("MTX_ERROR", `MTX header offsets out of bounds: offset2=${offset2}, offset3=${offset3}, size=${size}`);
	const offsets = [
		10,
		offset2,
		offset3
	];
	const blockSizes = [
		Math.max(0, offset2 - 10),
		Math.max(0, offset3 - offset2),
		Math.max(0, size - offset3)
	];
	const streams = [];
	const decompressedSizes = [];
	let budget = maxOutputBytes;
	for (let i = 0; i < 3; i++) {
		const decompressed = lzcompDecompress(data.subarray(offsets[i], offsets[i] + blockSizes[i]), blockSizes[i], versionMagic, budget);
		budget -= decompressed.length;
		streams.push(decompressed);
		decompressedSizes.push(decompressed.length);
	}
	return {
		streams,
		sizes: decompressedSizes
	};
}
/** Default ceiling on the size of a reconstructed font (128 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 134217728;
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
function decompressMtx(fontData, options) {
	try {
		return decompressMtxUnchecked(fontData, options);
	} catch (err) {
		throw toEotError(err);
	}
}
function decompressMtxUnchecked(fontData, options) {
	const encrypted = options?.encrypted ?? false;
	const compressed = options?.compressed ?? true;
	let data;
	if (encrypted) {
		data = new Uint8Array(fontData.length);
		for (let i = 0; i < fontData.length; i++) data[i] = fontData[i] ^ ENCRYPTION_KEY;
	} else data = fontData;
	if (!compressed) {
		const tag = data.length >= 4 ? (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0 : 0;
		if (tag !== 65536 && tag !== 1330926671 && tag !== 1953658213 && tag !== 1953784678) emitWarning(options, "WARN_NOT_SFNT", "uncompressed font data does not start with a recognised sfnt signature");
		return encrypted ? data : data.slice();
	}
	const maxOutputBytes = options?.maxOutputBytes ?? 134217728;
	let streams;
	try {
		({streams} = unpackMtx(data, data.length, maxOutputBytes));
	} catch (err) {
		if (err instanceof EotError && err.message.startsWith("LZCOMP output exceeds maximum size budget")) throw new EotError("MTX_ERROR", `decompressed streams exceed maxOutputBytes (${maxOutputBytes})`);
		throw err;
	}
	return dumpContainer(parseCTF(streams.map((buf) => new Stream(buf, buf.length)), {
		onWarn: options?.onWarn,
		onWarning: options?.onWarning
	}), { maxOutputBytes });
}
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
function decompressEotFont(fontData, compressed, encrypted) {
	return decompressMtx(fontData, {
		encrypted,
		compressed
	});
}
//#endregion
//#region src/eot.ts
/**
* EOT (Embedded OpenType) container parsing.
*
* Ported from libeot (MPL 2.0) — src/EOT.c. Parses the little-endian EOT
* header that wraps MTX-compressed font data, derives where the font data
* begins, and exposes the compression/encryption flags so callers no longer
* have to guess them. `eotToTtf` chains this into {@link decompressMtx} to
* turn a raw `.eot` file straight into a TrueType (or, for CFF outlines, OpenType) binary.
*
* Note: every field in the EOT header is LITTLE-endian, unlike the big-endian
* CTF/SFNT streams handled elsewhere in this library.
*
* @see http://www.w3.org/Submission/EOT/
*/
/** The font is a subset of the original. */
const TTEMBED_SUBSET = 1;
/** The font data is MTX-compressed. */
const TTEMBED_TTCOMPRESSED = 4;
/** The font data is XOR-obfuscated with key 0x50. */
const TTEMBED_XORENCRYPTDATA = 268435456;
/** Magic number appended after the code-page range fields (`"LP"` little-endian). */
const EOT_MAGIC = 20556;
/** fsType editing-permission mask (see {@link canLegallyEdit}). */
const EDITING_MASK = 8;
function readU16LE(bytes, at) {
	return bytes[at] | bytes[at + 1] << 8;
}
function readU32LE(bytes, at) {
	return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
}
/** Decode `count` UTF-16LE code units starting at `at` into a JS string. */
function decodeUtf16LE(bytes, at, byteLength) {
	let out = "";
	for (let i = 0; i < byteLength; i += 2) out += String.fromCharCode(readU16LE(bytes, at + i));
	return out;
}
/**
* A forward cursor over the header body. `limit` is the absolute index one past
* the last readable byte of the header (i.e. where the font data begins). The
* bound uses `>` (reading N bytes needs `pos + N <= limit`); libeot's
* `EOT_ENSURE_SCANNER` macro used `>=`, which is an off-by-one that spuriously
* rejects the exact-fit case — the string/array helpers there already use the
* correct `>`, so this matches libeot's intent.
*/
var Scanner = class {
	bytes;
	limit;
	pos;
	constructor(bytes, start, limit) {
		this.bytes = bytes;
		this.limit = limit;
		this.pos = start;
	}
	ensure(n) {
		if (this.pos + n > this.limit) throw new EotError("INSUFFICIENT_BYTES", `EOT header truncated: need ${n} more byte(s) at offset ${this.pos}`);
	}
	u16() {
		this.ensure(2);
		const v = readU16LE(this.bytes, this.pos);
		this.pos += 2;
		return v;
	}
	u32() {
		this.ensure(4);
		const v = readU32LE(this.bytes, this.pos);
		this.pos += 4;
		return v;
	}
	u8() {
		this.ensure(1);
		return this.bytes[this.pos++];
	}
	take(n) {
		this.ensure(n);
		const slice = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return slice;
	}
	skip(n) {
		this.ensure(n);
		this.pos += n;
	}
	/** Read a length-prefixed (U16LE byte count) UTF-16LE string. */
	string() {
		this.ensure(2);
		const size = readU16LE(this.bytes, this.pos);
		this.pos += 2;
		if (size % 2 !== 0) throw new EotError("BOGUS_STRING_SIZE", `EOT string size ${size} is not a multiple of 2 (UTF-16)`);
		if (size === 0) return "";
		this.ensure(size);
		const s = decodeUtf16LE(this.bytes, this.pos, size);
		this.pos += size;
		return s;
	}
	/** Read a length-prefixed (U32LE byte count) raw byte array. */
	byteArray() {
		this.ensure(4);
		const size = readU32LE(this.bytes, this.pos);
		this.pos += 4;
		if (size === 0) return /* @__PURE__ */ new Uint8Array(0);
		return this.take(size);
	}
};
/** Sentinel thrown internally to drive the version-retry loop. */
var HeaderTooBig = class extends Error {};
/**
* Parse the version-specific portion of the header. Mirrors
* `EOTfillMetadataSpecifyingVersion`. Throws {@link HeaderTooBig} when the parse
* consumed less than the declared header (a signal to try a higher version),
* {@link EotError} with `InsufficientBytes` when it ran past the end (try lower),
* and `CorruptFile` / `BogusStringSize` as terminal failures.
*/
function parseBody(bytes, version, totalSize, fontDataSize) {
	const sc = new Scanner(bytes, 12, bytes.length - fontDataSize);
	const flags = sc.u32();
	const panose = sc.take(10).slice();
	const charset = sc.u8();
	const italic = sc.u8() !== 0;
	const weight = sc.u32();
	const permissions = sc.u16();
	if (sc.u16() !== EOT_MAGIC) throw new EotError("CORRUPT_FILE", "EOT magic number (0x504C) mismatch");
	const unicodeRange = [
		sc.u32(),
		sc.u32(),
		sc.u32(),
		sc.u32()
	];
	const codePageRange = [sc.u32(), sc.u32()];
	const checkSumAdjustment = sc.u32();
	sc.skip(18);
	const familyName = sc.string();
	sc.skip(2);
	const styleName = sc.string();
	sc.skip(2);
	const versionName = sc.string();
	sc.skip(2);
	const fullName = sc.string();
	let rootString = "";
	let rootStringChecksum = 0;
	let eudcCodePage = 0;
	let eudcFlags = 0;
	let eudcFontData;
	if (version > 1) {
		sc.skip(2);
		rootString = sc.string();
		if (version === 3) {
			rootStringChecksum = sc.u32();
			eudcCodePage = sc.u32();
			sc.skip(2);
			const signatureSize = sc.u16();
			sc.skip(signatureSize);
			eudcFlags = sc.u32();
			const eudc = sc.byteArray();
			eudcFontData = eudc.length > 0 ? eudc.slice() : void 0;
		}
	}
	const fontDataOffset = sc.pos;
	if (fontDataOffset < totalSize - fontDataSize) throw new HeaderTooBig();
	return {
		version,
		flags,
		panose,
		charset,
		italic,
		weight,
		permissions,
		unicodeRange,
		codePageRange,
		checkSumAdjustment,
		familyName,
		styleName,
		versionName,
		fullName,
		rootString,
		rootStringChecksum,
		eudcCodePage,
		eudcFlags,
		eudcFontData,
		totalSize,
		fontDataSize,
		fontDataOffset
	};
}
const VERSION_MAGIC = {
	65536: 1,
	131073: 2,
	131074: 3
};
/** Normalise {@link BinaryInput} to a `Uint8Array` view (no copy). */
function toUint8Array(input) {
	if (input instanceof Uint8Array) return input;
	if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	return new Uint8Array(input);
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
function parseEotMetadata(input) {
	const bytes = toUint8Array(input);
	if (bytes.length < 8) throw new EotError("INSUFFICIENT_BYTES", "EOT file too small (need at least 8 bytes)");
	const totalSize = readU32LE(bytes, 0);
	const fontDataSize = readU32LE(bytes, 4);
	if (fontDataSize > totalSize) throw new EotError("CORRUPT_FILE", "EOT font data size exceeds declared total size");
	const metadataLength = totalSize - fontDataSize;
	if (bytes.length < metadataLength) throw new EotError("INSUFFICIENT_BYTES", `EOT file shorter than its declared metadata length (${metadataLength})`);
	if (bytes.length < 12) throw new EotError("INSUFFICIENT_BYTES", "EOT file too small for a version field");
	const versionMagic = readU32LE(bytes, 8);
	const codedVersion = VERSION_MAGIC[versionMagic];
	if (codedVersion === void 0) throw new EotError("CORRUPT_FILE", `unrecognized EOT version magic 0x${versionMagic.toString(16)}`);
	if (12 + fontDataSize > bytes.length) throw new EotError("CORRUPT_FILE", "EOT font data extends past end of file");
	let tryVersion = codedVersion;
	let bumpedUp = false;
	let knockedDown = false;
	while (true) try {
		const body = parseBody(bytes, tryVersion, totalSize, fontDataSize);
		const flags = body.flags;
		return {
			...body,
			compressed: (flags & 4) !== 0,
			encrypted: (flags & TTEMBED_XORENCRYPTDATA) !== 0,
			subset: (flags & 1) !== 0,
			badVersion: tryVersion !== codedVersion
		};
	} catch (err) {
		if (err instanceof HeaderTooBig) {
			if (knockedDown || tryVersion === 3) throw new EotError("CORRUPT_FILE", "EOT header inconsistent across all versions");
			knockedDown = false;
			bumpedUp = true;
			tryVersion = tryVersion + 1;
			continue;
		}
		if (err instanceof EotError && err.code === "INSUFFICIENT_BYTES") {
			if (bumpedUp || tryVersion === 1) throw new EotError("CORRUPT_FILE", "EOT header inconsistent across all versions");
			knockedDown = true;
			bumpedUp = false;
			tryVersion = tryVersion - 1;
			continue;
		}
		throw err;
	}
}
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
function inspectEotProtection(input) {
	const metadata = parseEotMetadata(input);
	return {
		encryption: metadata.encrypted ? "xor-0x50" : "none",
		passwordProtection: "not_supported_by_eot",
		embeddingPermissions: metadata.permissions,
		rootString: metadata.rootString
	};
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
function eotToTtf(input, options) {
	const bytes = toUint8Array(input);
	const meta = parseEotMetadata(bytes);
	if (meta.badVersion) emitWarning(options, "WARN_BAD_VERSION", `EOT header version disagrees with its layout; decoded as version ${meta.version}`);
	return decompressMtx(bytes.subarray(meta.fontDataOffset, meta.fontDataOffset + meta.fontDataSize), {
		compressed: meta.compressed,
		encrypted: meta.encrypted,
		onWarn: options?.onWarn,
		onWarning: options?.onWarning,
		maxOutputBytes: options?.maxOutputBytes
	});
}
/**
* Whether the font's embedding permissions allow editing.
*
* Mirrors libeot's `EOTcanLegallyEdit`. The upstream author asks that callers
* reflect before circumventing this: installable-permission fonts (`fsType`
* 0) and editable-embedding fonts may be edited; others may not.
*/
function canLegallyEdit(metadata) {
	return metadata.permissions === 0 || (metadata.permissions & EDITING_MASK) !== 0;
}
/**
* Promise-returning variant of {@link eotToTtf} that also accepts a `Blob`/`File`
* (convenient in browsers). Decoding itself still runs synchronously once the
* bytes are available.
*/
async function eotToTtfAsync(input, options) {
	return eotToTtf("arrayBuffer" in input && typeof input.arrayBuffer === "function" ? await input.arrayBuffer() : input, options);
}
//#endregion
exports.DEFAULT_MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;
exports.EOT_WARN = EOT_WARN;
exports.EotError = EotError;
exports.EotErrorCode = EotErrorCode;
exports.Stream = Stream;
exports.TTEMBED_SUBSET = TTEMBED_SUBSET;
exports.TTEMBED_TTCOMPRESSED = TTEMBED_TTCOMPRESSED;
exports.TTEMBED_XORENCRYPTDATA = TTEMBED_XORENCRYPTDATA;
exports.canLegallyEdit = canLegallyEdit;
exports.decompressEotFont = decompressEotFont;
exports.decompressMtx = decompressMtx;
exports.dumpContainer = dumpContainer;
exports.eotToTtf = eotToTtf;
exports.eotToTtfAsync = eotToTtfAsync;
exports.inspectEotProtection = inspectEotProtection;
exports.parseCTF = parseCTF;
exports.parseEotMetadata = parseEotMetadata;
exports.unpackMtx = unpackMtx;
