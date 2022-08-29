import { FileHash } from './fileHash'

export class HashStore {
  /** A map where the key is the file's path on disk and the value is a `FileHash` object. */
  public hashmap: Record<string, FileHash> = {}
}
