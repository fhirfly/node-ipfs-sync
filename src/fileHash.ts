import { readFileSync, statSync } from 'fs'
import { Level } from 'level'
import { xxh64 } from '@node-rs/xxhash'
import { HashStore } from './hashStore'
import { Configuration } from './config'
import * as log from './logger'

export class FileHash {
  constructor(
    public readonly pathOnDisk: string,
    /** Hex-encoded string. */
    public readonly hash: string,
    /** Hex-encoded string. */
    public readonly fakeHash: string,
  ) {}

  /** Recalculates the hash and returns a new instance with the recalculated hash. */
  recalculate(dontHash: boolean) {
    const { pathOnDisk, hash, fakeHash } = this

    const recalcFakeHash = FileHash.getFileFakeHash(pathOnDisk)
    if (recalcFakeHash === fakeHash) {
      // unchanged, return as is
      return this
    }

    return new FileHash(
      pathOnDisk,
      // recalculate hash only if requested
      dontHash ? hash : FileHash.getFileHash(pathOnDisk),
      recalcFakeHash
    )
  }

  private static getFileHash(filePath: string): string {
    const file = readFileSync(filePath)
    const hash = xxh64(file)
    return hash.toString(16)
  }

  private static getFileFakeHash(filePath: string): string {
    const stats = statSync(filePath)
    const size = stats.size
    const modTime = stats.mtimeMs
    const prehash = Buffer.from([
            0xff & size,
            0xff & (size >> 8),
            0xff & (size >> 16),
            0xff & (size >> 32),
            0xff & (size >> 40),
            0xff & (size >> 48),
            0xff & (size >> 56),
            0xff & (size >> 64),
            0xff & modTime,
            0xff & (modTime >> 8),
            0xff & (modTime >> 16),
            0xff & (modTime >> 32),
            0xff & (modTime >> 40),
            0xff & (modTime >> 48),
            0xff & (modTime >> 56),
            0xff & (modTime >> 64),
    ])
    return xxh64(prehash).toString(16)
  }
}

export class FileHashProcessor {
  constructor(
    private readonly config: Configuration,
    private readonly hashStore: HashStore,
    private readonly db?: Level<string, string>,
  ) {}

  /** Checks whether the hash of the given `@fileHash` is different from
   * the one stored in the database.
   * Updates the database entries if change detected.
   *
   * @returns `true` if updated
   */
  async update(fileHash: FileHash): Promise<boolean> {
    const { db } = this

    if (!db) {
      return false
    }

    let hashChanged = false
    let fakeHashChanged = false

    const dbHash = await db.get(fileHash.pathOnDisk)
    if (dbHash !== fileHash.hash) {
      await db.put(fileHash.pathOnDisk, fileHash.hash)
      hashChanged = true
    }

    const dbFakeHash = await db.get(`ts_${fileHash.pathOnDisk}`)
    if (dbFakeHash !== fileHash.fakeHash) {
      await db.put(`ts_${fileHash.pathOnDisk}`, fileHash.fakeHash)
      fakeHashChanged = true
    }

    return hashChanged && fakeHashChanged
  }

  /** Deletes file entries from the database that match the given `@path`.
   * Works with directories, in which case all children files and dirs are
   * also deleted.
   *
   * @param {string} path The path of a file or a directory.
   */
  async delete(path: string): Promise<void> {
    const { config: { verbose }, db, hashStore } = this

    if (!db) {
      return
    }

    const iterator = db.iterator({
      // equal to or starting with this string
      gte: path,
      // do not fetch the values from the db
      values: false,
    })
    for await (const [key] of iterator) {
      if (verbose) {
        log.info(`Deleting "${key}" from db...`)
      }

      await db.del(key)
      await db.del(`ts_${key}`)
      delete hashStore.hashmap[key]
    }
  }
}
