import { Stats } from 'fs'
import { readdir, stat } from 'fs/promises'
import { basename, extname, resolve, sep as PathSeparator } from 'path'
import { Level } from 'level'
import { Configuration } from './config'
import { EstuaryClient } from './estuaryClient'
import { IpfsClient, KEY_SPACE } from './ipfsClient'
import * as log from './logger'
import { err, ok, Option, Result, some } from './result'
import { FileHash, FileHashProcessor } from './fileHash'
import { HashStore } from './hashStore'

/** Invoke fs.readdir without throwing erros. */
async function readdirSafe(dir: string): Promise<Result<string[], Error>> {
  try {
    const entries = await readdir(dir)
    return ok(entries)
  } catch (e) {
    return err(e as Error)
  }
}

/** Invoke fs.stat without throwing erros. */
async function statSafe(path: string): Promise<Result<Stats, Error>> {
  try {
    const stats = await stat(path)
    return ok(stats)
  } catch (e) {
    return err(e as Error)
  }
}

/** Recursively walks over a given `dir` and collects the paths of all files.
 * When `ignoreHidden` is `true` ignores files with names starting with a dot (`.`).
 *
 * @returns An array with all files within the given `dir`.
*/
export async function walkdir(dir: string, ignoreHidden: boolean): Promise<Result<string[], Error>> {
  const getEntries = await readdirSafe(dir)
  if (!getEntries.ok) {
    return err(getEntries.error)
  }

  const files: string[] = []
  for (const entry of getEntries.value) {
    const path = resolve(dir, entry)
    const getStats = await statSafe(path)
    if (!getStats.ok) {
      return err(getStats.error)
    }

    const stats = getStats.value
    if (ignoreHidden && basename(path).length > 0 && basename(path).startsWith('.')) {
      // ignore hidden files and directories; move on to the next entry
      continue
    }

    if (stats.isFile()) {
      files.push(path)
      // move on to the next entry
      continue
    }

    // @path points to a directory
    const walkNestedDir = await walkdir(path, ignoreHidden)
    if (!walkNestedDir.ok) {
      return err(walkNestedDir.error)
    }

    files.push(...walkNestedDir.value)
  }

  return ok(files)
}

function sleep(time: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => resolve(), time)
  })
}

export class Watchdog {
  constructor(
    private readonly config: Configuration,
    private readonly hashStore: HashStore,
    private readonly hashProcessor: FileHashProcessor,
    private readonly ipfsClient: IpfsClient,
    private readonly estuaryClient: EstuaryClient,
    private readonly db?: Level<string, string>,
  ) {}

  async start(): Promise<Option<Error>> {
    const {
      config,
      db,
      estuaryClient,
      hashStore,
      hashProcessor,
      ipfsClient,
    } = this

    const getKeys = await ipfsClient.listKeys()
    if (!getKeys.ok) {
      return some(new Error('Failed to retrieve keys from IPFS client', { cause: getKeys.error }))
    }

    for (const dir of config.dirs) {
      let found = false

      const path = dir.Dir.split(PathSeparator)
      dir.MFSPath = path[path.length - 2]

      // hash dir if using db
      if (db) {
        if (config.verbose) {
          log.info(`Hashing ${dir.Dir} ...`)
        }

        const getHashes = await this.getDirFilesHash(dir.Dir, dir.DontHash)
        if (!getHashes.ok) {
          return some(new Error('Error hashing directory for hash db', { cause: getHashes.error }))
        }

        const localDirs: Record<string, boolean> = {}
        for (const hash of Object.values(getHashes.value)) {
          const hashUpdated = await hashProcessor.update(hash)
          if (hashUpdated) {
            if (config.verbose) {
              log.info(`File updated "${hash.pathOnDisk}"`)
            }

            // grab parent dir
            const filePath = hash.pathOnDisk.split(PathSeparator)
            const parentDirPath = filePath.slice(0, -1).join(PathSeparator)
            // check if we should create the parent dir (used later on below)
            const makeDir = !localDirs[parentDirPath]
            localDirs[parentDirPath] = true

            // make the MFS path from `pathOnDisk`
            const mfsPath = hash.pathOnDisk
              .slice(dir.Dir.length)
              // normalize path separator to MFS expected,
              // in case the OS path separator is different
              .replaceAll(PathSeparator, '/')

            const addToMfsResult = await this.addFile(
              hash.pathOnDisk,
              `${dir.MFSPath}/${mfsPath}`,
              dir.Nocopy,
              makeDir,
              false
            )
            if (!addToMfsResult.ok) {
              log.error('Error adding file', addToMfsResult.error)
            }
          }

          hashStore.hashmap[hash.pathOnDisk] = hash
        }
      }

      // check if we recognize any keys, mark them as found and load them
      for (const key of getKeys.value) {
        if (key.name === `${KEY_SPACE}${dir.ID}`) {
          const resolveKeyCid = await ipfsClient.resolveIPNS(key.id)
          if (!resolveKeyCid.ok) {
            log.error('Error resolving IPNS', resolveKeyCid.error)
            log.info('Republishing key...')
            dir.CID = await ipfsClient.getFileCID(dir.MFSPath)
            await ipfsClient.publish(dir.CID, dir.ID)
          }

          found = true
          log.info(`${dir.ID} loaded: ${key.id}`)

          // todo: watchDir(dir.Dir, dir.Nocopy, dir.DontHash)
          break
        }
      }

      if (found) {
        continue
      }

      log.info(`${dir.ID} not found, generating...`)
      const generateKeyResult = await ipfsClient.generateKey(dir.ID)
      if (!generateKeyResult.ok) {
        return some(new Error(
          'Could not generate IPNS key for watched dir.',
          { cause: generateKeyResult.error }
        ))
      }

      const addDirResult = await this.addDir(dir.Dir, dir.Nocopy, dir.Pin, dir.Estuary)
      if (!addDirResult.ok) {
        return some(new Error(
          'Failed to add directory',
          { cause: addDirResult.error }
        ))
      }

      dir.CID = addDirResult.value
      await ipfsClient.publish(dir.CID, dir.ID)
      log.info(`${dir.ID} loaded: ${generateKeyResult.value}`)

      // todo: watchDir(dir.Dir, dir.Nocopy, dir.DontHash)
    }

    // main loop
    while (true) {
      await sleep(config.sync)

      for (const dir of config.dirs) {
        const fcid = await ipfsClient.getFileCID(dir.MFSPath)
        if (fcid && fcid !== dir.CID) {
          if (dir.Pin) {
            await ipfsClient.updatePin(dir.CID, fcid, dir.Nocopy)
          }

          if (dir.Estuary) {
            await estuaryClient.updatePin(dir.CID, fcid, dir.MFSPath.split('/')[0])
          }

          await ipfsClient.publish(fcid, dir.ID)
          dir.CID = fcid

          log.info(`${dir.MFSPath} updated...`)
        }
      }
    }
  }

  /** Adds a file to the MFS relative to the `Configuration.basePath`.
   *
   * @param {string} pathOnDisk The full path to the file intended to be added.
   * @param {boolean} makeDir When `true`, the parent directory will be created.
   * @param {boolean} overwrite When `true`, will try to remove the file from MFS before adding it.
   */
  async addFile(
    pathOnDisk: string,
    mfsPath: string,
    noCopy: boolean,
    makeDir: boolean,
    overwrite: boolean
  ): Promise<Result<string, Error>> {
    const { config: { basePath, verbose }, ipfsClient } = this

    log.info(`Adding file from "${pathOnDisk}" to "${basePath}${mfsPath}"...`)
    const addFileResult = await ipfsClient.addFile(pathOnDisk, noCopy, false)
    if (!addFileResult.ok) {
      return err(addFileResult.error)
    }

    if (makeDir) {
      const mfsPathParts = mfsPath.split('/')
      const mfsParent = mfsPathParts.slice(0, -1).join('/')
      if (verbose) {
        log.info(`Creating parent directory "${mfsParent}" in MFS...`)
      }

      const makeDirError = await ipfsClient.makeDir(mfsParent)
      if (makeDirError.hasValue) {
        return err(makeDirError.value)
      }
    }

    if (overwrite) {
      if (verbose) {
        log.info('Removing existing file, if any...')
      }

      await ipfsClient.removeFile(mfsPath)
    }

    if (verbose) {
      log.info(`Adding file to MFS path "${basePath}${mfsPath}"...`)
    }

    const ipfsHash = addFileResult.value
    const copyFileError = await ipfsClient.copyFile(
      `/ipfs/${ipfsHash}`,
      `${basePath}${mfsPath}`
    )
    if (copyFileError.hasValue) {
      if (verbose) {
        log.error('Error on files/cp', copyFileError.value)
			  log.error(`File path "${pathOnDisk}"`)
      }

      const hasBadBlockError = await ipfsClient.handleBadBlockError(
        copyFileError.value,
        pathOnDisk,
        noCopy
      )
      if (hasBadBlockError) {
  			log.info('files/cp failure due to filestore, retrying (recursive)')
        await this.addFile(pathOnDisk, mfsPath, noCopy, makeDir, overwrite)
      }
    }

    return ok(ipfsHash)
  }

  /** Adds a directory along all its children files (recursively), and returns the directory CID. */
  async addDir(
    path: string,
    noCopy: boolean,
    pin: boolean,
    estuary: boolean
  ): Promise<Result<string, Error>> {
    const { config: { ignoreHidden }, estuaryClient, ipfsClient } = this

    const pathParts = path.split(PathSeparator)
    const dirName = pathParts.splice(-2, 1)[0]
    const getDirFiles = await walkdir(dirName, ignoreHidden)
    if (!getDirFiles.ok) {
      return err(getDirFiles.error)
    }

    const localDirs: Record<string, boolean> = {}
    for (const file of getDirFiles.value) {
      const filePathParts = file.split(PathSeparator)
      const parentDir = filePathParts.slice(0, -1).join(PathSeparator)
      const makeDir = !localDirs[parentDir]
      localDirs[parentDir] = true

      const mfsPath = file
        .slice(path.length)
        // normalize path separator to MFS expected,
        // in case the OS path separator is different
        .replaceAll(PathSeparator, '/')

      const addFileResult = await this.addFile(
        file,
        `${dirName}/${mfsPath}`,
        noCopy,
        makeDir,
        false
      )
      if (!addFileResult.ok) {
        log.error('Error adding file', addFileResult.error)
      }
    }

    const cid = await ipfsClient.getFileCID(dirName)

    if (pin) {
      const pinError = await ipfsClient.pin(cid)
      if (pinError.hasValue) {
        log.error(`Error pinning "${dirName}"`, pinError.value)
      }
    }

    if (estuary) {
      const pinEstuaryError = await estuaryClient.pin(cid, dirName)
      if (pinEstuaryError.hasValue) {
        log.error('Error pinning to Estuary', pinEstuaryError.value)
      }
    }

    return ok(cid)
  }

  /** Recursively walks through the directory at `path` and returns the `FileHash` for every file. */
  private async getDirFilesHash(
    path: string,
    dontHash: boolean
  ): Promise<Result<Record<string, FileHash>, Error>> {
    const {
      db,
      config: {
        ignore,
        ignoreHidden,
        verbose
      }
    } = this

    if (!db) {
      return err(new Error('Database not provided'))
    }

    const getFiles = await walkdir(path, ignoreHidden)
    if (!getFiles.ok) {
      return err(getFiles.error)
    }

    const hashes: Record<string, FileHash> = {}
    for (const file of getFiles.value) {
      if (verbose) {
        log.info(`Loading "${file}"...`)
      }

      const extension = extname(file)
      if (ignore.includes(extension)) {
        continue
      }

      // loading existing data from db
      const fakeHash = await db.get(`ts_${file}`)
      const hash = dontHash ? '' : await db.get(file)
      hashes[file] = new FileHash(file, hash, fakeHash).recalculate(dontHash)
    }

    return ok(hashes)
  }
}
