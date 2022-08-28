import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { OptionValues } from 'commander'
import parseDuration from 'parse-duration'
import { parse as parseYaml } from 'yaml'

import { version as PackageVersion } from '../package.json'
import sampleConfigYaml from './config.sample.yaml'
import * as log from './logger'

/** Used for keeping track of directories. */
export interface DirKey {
	ID: string
	Dir: string
	Nocopy: boolean
	DontHash: boolean
	Pin: boolean
	Estuary: boolean

	CID: string
	MFSPath: string
}

/** Represents the arguments passed from the CLI. */
export interface Args extends OptionValues {
  /** Relative MFS directory path */
  basePath?: string
  /** Node to connect to over HTTP */
  endpoint?: string
  /** Time to wait between IPNS syncs, in milliseconds */
  sync?: number
  /** Longest time to wait for API calls like `version` and `files/mkdir`, in milliseconds */
  timeout?: number
  /** Path to config file to use */
  config?: string
  /** Path to file where db should be stored */
  db?: string
  /** Ignore files prefixed with `.` (dot) */
  ignoreHidden?: boolean
  /** The dirs to monitor */
  dirs?: DirKey[]
  /** The suffixes to ignore */
  ignore?: string[]
  /** Verify filestore on startup. Not recommended unless you're having issues */
  verifyFilestore?: boolean
  /** Display copyright and exit */
  copyright: boolean
  /** Display version and exit */
  version: boolean
  /** Display verbose output */
  verbose: boolean
}

/** Used for loading information from a YAML config file. */
export class ConfigFile {
  private constructor(
    public BasePath?: string,
    public EndPoint?: string,
    public Dirs?: DirKey[],
    public Sync?: number,
    public Ignore?: string[],
    public DB?: string,
    public IgnoreHidden?: boolean,
    public Timeout?: number,
    public EstuaryAPIKey?: string,
    public VerifyFilestore?: boolean,
  ) {}

  /** Tries to load the configuration from the file at the specified `path`.
   * If the file at the path does not exist, a sample config file is generated and
   * stored at the same path.
   *
   * @param {string} path The path to the config file.
   *
   * @returns {ConfigFile | null} The parsed config file or `null` in case an error occurred.
  **/
  static load(path: string): ConfigFile | null {
    log.info('Loading config file', path)

    if (!existsSync(path)) {
      log.info(`Config file not found at "${path}", generating...`)
      try {
        writeFileSync(path, sampleConfigYaml, { encoding: 'utf8' })
      } catch (e) {
        log.error('Could not generate config file', e)
        log.error('Skipping config file')
        return null
      }
    }

    let contents: string
    try {
      contents = String(readFileSync(path))
    } catch (e) {
      log.error(`Could not read config file at path "${path}"`, e)
      return null
    }

    let config
    try {
      config = parseYaml(contents)
    } catch (e) {
      log.error('Could not parse config file', e)
      return null
    }

    return new ConfigFile(
      config.BasePath,
      config.EndPoint,
      config.Dirs,
      config.Sync ? parseDuration(config.Sync) : undefined,
      config.Ignore,
      config.DB,
      config.IgnoreHidden,
      config.Timeout ? parseDuration(config.Timeout) : undefined,
      config.EstuaryAPIKey,
      config.VerifyFilestore,
    )
  }
}

/** Represents the working configuration of the application. */
export class Configuration {
  private constructor(
    /** Relative MFS directory path */
    public basePath: string,
    /** Node to connect to over HTTP */
    public endpoint: string,
    /** Time to sleep between IPNS syncs in milliseconds */
    public sync: number,
    /** Longest time in milliseconds to wait for API calls like `version` and `files/mkdir` */
    public timeout: number,
    /** Path to config file to use */
    public config: string,
    /** Path to file where db should be stored */
    public db: string,
    /** Ignore files prefixed with `.` (dot) */
    public ignoreHidden: boolean,
    /** The dirs to monitor */
    public dirs: DirKey[],
    /** The suffixes to ignore */
    public ignore: string[],
    /** Verify filestore on startup. Not recommended unless you're having issues */
    public verifyFilestore: boolean,
    /** Display verbose output */
    public verbose: boolean,
    /** The application version */
    public version: string,
    /** API key for Estuary */
    public estuaryApiKey?: string,
  ) {}

  /** Creates the app configuration by merging the config from the CLI `args` and `configFile` sources.
   * If a config is present in both sources - the `args` version takes precedence.
   * If a config is missing from both sources a default value is used.
   *
   * @param {Args} args Configuration provided via the CLI args. Values from this source
   * take precendence over the config file source.
   * @param {ConfigFile | null} configFile Configuration provided via the config file. Values
   * from this source are used by default, unless overridden from the CLI args source.
   *
   * @returns The app configuration built by merging the two configuration sources.
   */
  static create(args: Args, configFile: ConfigFile | null): Configuration {
    return new Configuration(
      args.basePath
        ? args.basePath
        : (configFile?.BasePath ?? join(homedir(), '/ipfs-sync/')),
      args.endpoint
        ? args.endpoint
        : (configFile?.EndPoint ?? 'http://127.0.0.1:5001'),
      args.sync
        ? args.sync
        : (configFile?.Sync ?? parseDuration('10s', 'ms')),
      args.timeout
        ? args.timeout
        : (configFile?.Timeout ?? parseDuration('30s', 'ms')),
      args.config ?? join(homedir(), '.ipfs-sync.yaml'),
      args.db
        ? args.db
        : (configFile?.DB ?? join(homedir(), '.ipfs-sync.db')),
      args.ignoreHidden !== undefined
        ? args.ignoreHidden
        : (configFile?.IgnoreHidden !== undefined ? configFile.IgnoreHidden : false),
      args.dirs
        ? args.dirs
        : (configFile?.Dirs ?? []),
      args.ignore
        ? args.ignore
        : (configFile?.Ignore ?? ['kate-swp', 'swp', 'part', 'crdownload']),
      args.verifyFilestore !== undefined
        ? args.verifyFilestore
        : (configFile?.VerifyFilestore !== undefined ? configFile.VerifyFilestore : false),
      args.verbose,
      PackageVersion ?? 'devel',
      configFile?.EstuaryAPIKey,
    )
  }
}
