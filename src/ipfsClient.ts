import { readFileSync } from 'fs'
import { basename } from 'path'

import * as log from './logger'
import { Configuration } from './config'
import { HttpClient, HttpError } from './httpClient'
import { err, none, ok, Option, Result, some } from './result'

export const KEY_SPACE = 'ipfs-sync.'
const API_PREFIX = '/api/v0/'

export type Key = {
  id: string
  name: string
}

export class IpfsClient {
  private readonly http: HttpClient

  constructor(private readonly config: Configuration) {
    const url = config.endpoint.endsWith('/')
      ? config.endpoint.slice(0, -1)
      : config.endpoint
    this.http = new HttpClient(`${url}${API_PREFIX}`, {})
  }

  /** Gets a file CID based on MFS path relative to BasePath. */
  async getFileCID(filePath: string): Promise<string> {
    const response = await this.http.post('files/stat', {
      timeout: this.config.timeout,
      query: {
        hash: true,
        arg: `${this.config.basePath}${filePath}`
      }
    })

    if (!response.ok) return ''

    try {
      const fileStat = JSON.parse(response.value) as { Hash: string }
      return fileStat.Hash
    } catch {
      return ''
    }
  }

  /** Removes a file from the MFS relative to BasePath. */
  async removeFile(filePath: string): Promise<Option<HttpError>> {
    const response = await this.http.post('files/rm', {
      timeout: this.config.timeout,
      query: {
        arg: `${this.config.basePath}${filePath}`,
        force: true
      }
    })
    return response.ok ? none() : some(response.error)
  }

  /** Makes a directory along with parents in path. */
  async makeDir(path: string): Promise<Option<HttpError>> {
    const response = await this.http.post('files/mkdir', {
      timeout: this.config.timeout,
      query: {
        arg: `${this.config.basePath}${path}`,
        parents: true
      }
    })
    return response.ok ? none() : some(response.error)
  }

  /** Add a file to IPFS. If `onlyhash` is `true`, only the CID is generated and returned.
   * @returns A `Result` containing the hash of the newly added file as value on success, or
   * the error that ocurred on failure.
  */
  async addFile(filePath: string, noCopy: boolean, onlyHash: boolean): Promise<Result<string, HttpError>> {
    const { verbose } = this.config

    if (verbose) {
      log.info(`Preparing to add file "${filePath}"...`)
    }
    const fileContents = readFileSync(filePath)
    const fileBinary = new Uint8Array(fileContents)
    const fileData = new File([fileBinary], basename(filePath))

    if (verbose) {
      log.info('Generating file headers...')
    }
    const formData = new FormData()
    formData.set('Abspath', filePath)
    formData.set('Content-Disposition', `form-data; name=file; filename=${basename(filePath)}`)
    formData.set('Content-Type', 'application/octet-stream')
    formData.set('file', fileData)

    if (verbose) {
      log.info('Making add request...')
    }
    const response = await this.http.post('add', {
      query: {
        'nocopy': noCopy,
        'only-hash': onlyHash,
        'pin': false,
        'quieter': true,
      },
      body: formData,
    })

    if (!response.ok) return response

    const json = JSON.parse(response.value) as { Hash: string }
    if (verbose) {
      log.info(`File hash:`, json.Hash)
    }

    return ok(json.Hash)
  }

  /** Add references to IPFS files and directories in MFS (or copy within MFS). */
  async copyFile(source: string, destination: string): Promise<Option<HttpError>> {
    const response = await this.http.post(`files/cp`, {
      timeout: this.config.timeout,
      query: new URLSearchParams([
        ['arg', source],
        ['arg', destination],
      ]),
    })
    return response.ok ? none() : some(response.error)
  }

  /** Remove object from pin list. */
  async removePin(cid: string): Promise<Option<HttpError>> {
    const response = await this.http.post('pin/rm', {
      query: { arg: cid }
    })
    return response.ok ? none() : some(response.error)
  }

  /** Remove block, even if pinned. */
  async removeBlock(cid: string): Promise<void> {
    let response = await this.http.post('block/rm', { query: { arg: cid } })
    while (!response.ok && response.error.getError().startsWith('pinned')) {
      // Block is pinned
      const errorParts = response.error.getError().split(' ')
      const pinCid = errorParts.length >= 3
        ? errorParts[2]
        /* This is caused by IPFS returning "pinned (recursive)",
         * it means the file in question has been explicitly pinned,
         * and for some unknown reason, it chooses to omit the CID
         * in this particular situation, so we use the original CID
        */
        : cid

      log.info('Effected block is pinned, removing pin:', pinCid)
      const removePinResult = await this.removePin(pinCid)
      if (removePinResult.hasValue) {
        log.error(`Error removing pin (${pinCid})`, removePinResult.value)
      }

      response = await this.http.post('block/rm', { query: { arg: cid } })
    }

    if (!response.ok) {
      log.error(`Error removing block (${cid})`, response.error)
    }
  }

  /** Completely removes a CID, even if pinned. */
  async removeCID(cid: string): Promise<void> {
    const { verbose } = this.config

    const response = await this.http.post('refs', {
      query: {
        unique: true,
        recursive: true,
        arg: cid,
      },
      streamResponse: true,
    })

    if (!response.ok) {
      log.error('Request to /refs to list references from an object failed', response.error)
      return
    }

    let foundRefs = false

    try {
      for await (const chunk of response.value) {
        foundRefs = true
        try {
          const data = JSON.parse(chunk.toString()) as { Err: string, Ref: string }
          const refCid = data.Ref ?? cid
          if (verbose) {
            log.info('Removing block', refCid)
          }

          await this.removeBlock(refCid)
        } catch (e) {
          log.error('Error parsing /refs chunk', e)
        }
      }
    } catch (e) {
      log.error('Error while reading /refs chunk', e)
    }

    if (!foundRefs) {
      if (verbose) {
        log.info('Removing block', cid)
      }
      await this.removeBlock(cid)
    }
  }

  /** Removes blocks that point to files that don't exist. */
  async cleanFilestore() {
    const { verbose } = this.config

    if (verbose) {
      log.info('Removing blocks that point to a file that doesn\'t exist from filestore...')
    }

    const response = await this.http.post('filestore/verify', {
      streamResponse: true
    })

    if (!response.ok) {
      log.error('Error while verifying objects in filestore at filestore/verify', response.error)
      return
    }

    try {
      const NoFileStatus = 11
      for await (const chunk of response.value) {
        try {
          const fsEntry = JSON.parse(chunk.toString()) as {
            Status: number
            Key: { '/': string }
          }
          if (fsEntry.Status === NoFileStatus) {
            // the filestore entry points to a file that doesn't exist, remove it
            const cid = fsEntry.Key['/']
            log.info('Removing reference from filestore', cid)
            await this.removeBlock(cid)
          }
        } catch (e) {
          log.error('Error parsing filestore/verify chunk', e)
        }
      }
    } catch (e) {
      log.error('Error while reading filestore/verify chunk', e)
    }
  }

  /** Pin CID. */
  async pin(cid: string): Promise<Option<HttpError>> {
    const { verbose } = this.config

    const response = await this.http.post('pin/add', {
      query: { arg: cid }
    })

    if (!response.ok && verbose) {
      log.error(`Error pinning cid (${cid})`, response.error)
    }

    return response.ok ? none() : some(response.error)
  }

  /** UpdatePin updates a recursive pin to a new CID, unpinning old content. */
  async updatePin(from: string, to: string, noCopy: boolean): Promise<void> {
    const { verbose } = this.config

    const response = await this.http.post(`pin/updated`, {
      query: new URLSearchParams([
        ['arg', from],
        ['arg', to]
      ])
    })

    if (!response.ok) {
      log.error('Error updating pin', response.error)
      if (verbose) {
        log.error(`From CID (${from}) to CID (${to})`)
      }

      const hasBadBlockError = await this.handleBadBlockError(response.error, '', noCopy)
      if (hasBadBlockError) {
        if (verbose) {
          log.info('Bad blocks found, running pin/update again (recursive)')
        }
        await this.updatePin(from, to, noCopy)
        return
      }

      const pinCidError = await this.pin(to)
      if (pinCidError.hasValue) {
        log.error('Error adding pin', pinCidError.value)
      }
    }
  }

  /** Runs `cleanFilestore()` and returns `true` if there was a bad block error. */
  async handleBadBlockError(error: HttpError, filePath: string, noCopy: boolean): Promise<boolean> {
    const err = error.getError()
    if (!err.startsWith('failed to get block') && !err.startsWith('no such file or directory')) {
      return false
    }

    // txt starts with either 'failed to get block' or 'no such file or directory'
    const { verbose } = this.config
    if (verbose) {
      log.info('Handling bad block error', err)
    }

    if (!filePath) {
      // TODO: attempt to get fpath from error msg when possible
      await this.cleanFilestore()
    } else {
      const addFile = await this.addFile(filePath, noCopy, true)
      if (addFile.ok) {
        await this.removeCID(addFile.value)
      } else {
        log.error('Error handling bad block error', addFile.error)
      }
    }

    return true
  }

  /** Returns all the keys in the IPFS daemon.
   *
   * **TODO: Only return keys in the namespace.**
  */
  async listKeys(): Promise<Result<Key[], HttpError>> {
    const response = await this.http.post('key/list')
    if (!response.ok) {
      return err(response.error)
    }

    const data = JSON.parse(response.value) as { Keys: { Id: string, Name: string }[] }
    const keys = data.Keys.map(x => ({ id: x.Id, name: x.Name }))
    return ok(keys)
  }

  /** Takes an IPNS key and returns the CID it resolves to. */
  async resolveIPNS(key: string): Promise<Result<string, HttpError>> {
    const response = await this.http.post('name/resolve', {
      query: { arg: key }
    })

    if (!response.ok) {
      return err(response.error)
    }

    const data = JSON.parse(response.value) as { Path: string }
    const path = data.Path.split('/')
    if (path.length < 3) {
      return err(HttpError.fromMessage(`Unexpected output from name/resolve: ${data.Path}`))
    }

    return ok(path[2])
  }

  /** Generates an IPNS key in the keyspace based on name. */
  async generateKey(name: string): Promise<Result<Key, HttpError>> {
    const response = await this.http.post('key/gen', {
      query: { arg: `${KEY_SPACE}${name}` }
    })

    if (!response.ok) {
      return err(response.error)
    }

    const data = JSON.parse(response.value) as { Id: string, Name: string }
    // normalize the received data into lowercased object properties
    return ok({ id: data.Id, name: data.Name })
  }

  /** Publish CID to IPNS. */
  async publish(cid: string, key: string): Promise<Option<HttpError>> {
    const response = await this.http.post('name/publish', {
      query: {
        arg: cid,
        key: key,
      }
    })

    return response.ok ? none() : some(response.error)
  }

  /** Returns the IPFS version. */
  async version(): Promise<Result<string, HttpError>> {
    const response = await this.http.post('version')
    if (!response.ok) {
      return err(response.error)
    }

    const data = JSON.parse(response.value) as { Version: string }
    return ok(data.Version)
  }
}
