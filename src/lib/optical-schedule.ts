/**
 * The scheduler supports every exactly representable JavaScript chunk count.
 * Wire protocols may impose a smaller limit. It never allocates storage
 * proportional to this value.
 */
export const MAX_OPTICAL_CHUNKS = Number.MAX_SAFE_INTEGER

export interface OpticalPassScheduleOptions {
  /** Number of data chunks in the transfer. */
  totalChunks: number
  /** Zero-based completed-pass count. */
  pass: number
  /** Stable unsigned 32-bit transfer seed, normally the QRF2 transfer ID. */
  seed: number
}

/**
 * A deterministic, non-cryptographic permutation for one optical pass.
 *
 * The permutation is affine modulo `totalChunks`. Its stride is always
 * coprime to `totalChunks`, so every chunk index appears exactly once. Both
 * stride and phase are derived from the transfer seed; the stride is re-keyed
 * for each pass and the phase advances by a coprime amount. This spreads
 * periodic camera losses across different chunks on later passes.
 *
 * Iteration uses O(1) memory and O(1) number arithmetic per item. Random
 * access also uses O(1) memory; it falls back to BigInt only when a product
 * would exceed JavaScript's exact-integer range.
 */
export class OpticalPassSchedule implements Iterable<number> {
  readonly totalChunks: number
  readonly pass: number
  readonly seed: number
  /** Chunk index emitted at logical position zero. */
  readonly phase: number
  /** Modular increment between consecutively emitted chunk indices. */
  readonly stride: number

  constructor(options: OpticalPassScheduleOptions) {
    assertChunkCount(options.totalChunks)
    assertPass(options.pass)
    assertUint32(options.seed, 'seed')

    this.totalChunks = options.totalChunks
    this.pass = options.pass
    this.seed = options.seed

    if (this.totalChunks === 1) {
      this.phase = 0
      this.stride = 0
      return
    }

    const passKey = foldSafeInteger(options.pass)
    this.stride = nextCoprime(
      mix32(options.seed ^ passKey ^ 0x9e37_79b9),
      this.totalChunks,
    )

    // Advancing phase with a transfer-stable coprime stride guarantees that
    // consecutive passes start on different chunks (for totalChunks > 1),
    // even in the unlikely event that their data strides collide.
    const phaseBase = mix32(options.seed ^ 0xa511_e9b3) % this.totalChunks
    const phaseStride = nextCoprime(
      mix32(options.seed ^ 0x63d8_3595),
      this.totalChunks,
    )
    const passModulo = Number(
      BigInt(options.pass) % BigInt(this.totalChunks),
    )
    const passPhase = multiplyModulo(
      phaseStride,
      passModulo,
      this.totalChunks,
    )
    this.phase = addModulo(phaseBase, passPhase, this.totalChunks)
  }

  /** Return the chunk index at a zero-based position within this pass. */
  indexAt(position: number): number {
    assertPosition(position, this.totalChunks, false)
    return addModulo(
      this.phase,
      multiplyModulo(this.stride, position, this.totalChunks),
      this.totalChunks,
    )
  }

  /**
   * Iterate from a logical position without replaying or materializing the
   * preceding indices. Passing `totalChunks` returns an empty iterator.
   */
  *indices(startPosition = 0): IterableIterator<number> {
    assertPosition(startPosition, this.totalChunks, true)
    if (startPosition === this.totalChunks) return

    let chunkIndex = this.indexAt(startPosition)
    for (let position = startPosition; position < this.totalChunks; position += 1) {
      yield chunkIndex
      chunkIndex = addModulo(chunkIndex, this.stride, this.totalChunks)
    }
  }

  [Symbol.iterator](): IterableIterator<number> {
    return this.indices()
  }
}

export function createOpticalPassSchedule(
  options: OpticalPassScheduleOptions,
): OpticalPassSchedule {
  return new OpticalPassSchedule(options)
}

function assertChunkCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OPTICAL_CHUNKS) {
    throw new RangeError(
      `totalChunks must be an integer between 1 and ${MAX_OPTICAL_CHUNKS}.`,
    )
  }
}

function assertPass(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('pass must be a non-negative safe integer.')
  }
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer.`)
  }
}

function assertPosition(position: number, totalChunks: number, allowEnd: boolean): void {
  const upperBound = allowEnd ? totalChunks : totalChunks - 1
  if (!Number.isSafeInteger(position) || position < 0 || position > upperBound) {
    throw new RangeError(
      allowEnd
        ? 'startPosition must be within this pass or exactly at its end.'
        : 'position must be within this pass.',
    )
  }
}

/** Murmur-inspired 32-bit avalanche used only to derive schedule parameters. */
function mix32(input: number): number {
  let value = input >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb_352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846c_a68b)
  value ^= value >>> 16
  return value >>> 0
}

function foldSafeInteger(value: number): number {
  const low = value % 0x1_0000_0000
  const high = Math.floor(value / 0x1_0000_0000)
  return mix32((low >>> 0) ^ mix32(high >>> 0))
}

function nextCoprime(entropy: number, modulus: number): number {
  let candidate = entropy % modulus
  if (candidate === 0) candidate = 1

  const bigintModulus = BigInt(modulus)
  while (greatestCommonDivisor(BigInt(candidate), bigintModulus) !== 1n) {
    candidate += 1
    if (candidate === modulus) candidate = 1
  }
  return candidate
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left
  let b = right
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function addModulo(left: number, right: number, modulus: number): number {
  // Both operands are below modulus. Avoid forming an inexact sum when the
  // scheduler is used near Number.MAX_SAFE_INTEGER.
  return right >= modulus - left ? right - (modulus - left) : left + right
}

function multiplyModulo(left: number, right: number, modulus: number): number {
  if (left === 0 || right === 0) return 0
  if (left <= Math.floor(Number.MAX_SAFE_INTEGER / right)) {
    return (left * right) % modulus
  }
  return Number((BigInt(left) * BigInt(right)) % BigInt(modulus))
}

/*
 * Deliberately no XOR parity is emitted here. QRF2 currently has no parity
 * frame type, group identifier, or manifest commitment for recovery metadata.
 * Smuggling parity into a Data frame would either corrupt reconstruction or
 * leave the recovery information unauthenticated. Forward-error correction
 * should therefore be added as a versioned protocol feature; this scheduler
 * remains wire-format neutral and can be adopted independently.
 */
