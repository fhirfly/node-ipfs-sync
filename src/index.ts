import { homedir } from 'os'
import { join, sep as PathSeparator } from 'path'
import { program } from 'commander'
import { Level } from 'level'
import parseDuration from 'parse-duration'
import * as log from './logger'
import { Args, ConfigFile, Configuration } from './config'
import { version as PackageVersion } from '../package.json'
import { IpfsClient } from './ipfsClient'
import { EstuaryClient } from './estuaryClient'
import { Watchdog } from './watchdog'
import { HashStore } from './hashStore'
import { FileHashProcessor } from './fileHash'

program
  .option('--base-path <base-path>', 'Relative MFS directory path (default: /ipfs-sync/)')
  .option('--endpoint <endpoint>', 'Node to connect to over HTTP (default: http://127.0.0.1:5001)')
  .option(
    '--sync <duration>',
    'Time to wait between IPNS syncs, eg. "10s" or "1m 30s" (default: 10s)',
    value => parseDuration(value)
  )
  .option(
    '--timeout <duration>',
    'Longest time to wait for short API calls like "version" and "files/mkdir", eg. "10s" or "1m 30s" (default: 30s)',
    value => parseDuration(value)
  )
  .option('--config <file-path>', `Path to config file to use (default: ${join(homedir(), '.ipfs-sync.yaml')})`)
  .option('--db <db-path>', `Path to file where db should be stored (default: ${join(homedir(), '.ipfs-sync.db')})`)
  .option('--ignore-hidden', 'Ignore files prefixed with "." (default: false)')
  .option(
    '--dirs <list>',
    'A JSON array of directory configurations to monitor, eg. [{ "ID": "Example1", "Dir": "/home/user/Documents/", "Nocopy": false}, { "ID": "Example2", "Dir": "/home/user/Pictures/", "Nocopy": false }] (default: [])',
    value => JSON.parse(value)
  )
  .option(
    '--ignore <suffixes>',
    'A comma-separated list of suffixes to ignore (default: kate-swp,swp,part)',
    value => value.split(',').map(x => x.trim())
  )
  .option('--verify', 'Verify filestore on startup; not recommended unless you\'re having issues (default: false)')
  .option('--copyright', 'Display copyright and exit', false)
  .option('--version', 'Display version and exit', false)
  .option('-v, --verbose', 'Display verbose output', false)
  .parse()

async function main() {
  const args: Args = program.opts()

  if (args.verbose) {
    log.info('CLI args', args)
  }

  if (args.copyright) {
    log.log('Copyright © 2022, The node-ipfs-sync Contributors. All rights reserved.')
    log.error('[TODO] Add license')
    log.error('[TODO] Add link to license')
    process.exit(0)
  }

  if (args.version) {
    log.log(`node-ipfs-sync ${PackageVersion ?? 'devel'}`)
    process.exit(0)
  }

  log.info("Loading configuration...")

  let config!: Configuration
  if (args.config) {
    const configFile = ConfigFile.load(args.config)
    config = Configuration.create(args, configFile)
  }

  // Make sure dirs are provided
  if (config.dirs.length === 0) {
    log.fatal(
      'Missing configuration for directories to watch; provide the "--dirs" CLI option ' +
      'or configure the "Dirs" sequence in the YAML config file'
    )
    process.exit(1)
  }

  // Check if dirs entries are at least somewhat valid
  for (const dir of config.dirs) {
    if (!dir.Dir) {
      log.fatal(`Dir entry path cannot be empty (ID: ${dir.ID})`)
      process.exit(1)
    }

    // Check if trailing "/" exists, if not, append it
    if (dir.Dir.slice(-1) !== PathSeparator) {
      dir.Dir += PathSeparator
    }
  }

  if (config.verbose) {
    log.info(config)
  }

  const database = config.db
    ? new Level(config.db, { valueEncoding: 'utf8' })
    : undefined

  const ipfsClient = new IpfsClient(config)
  const estuaryClient = new EstuaryClient(config)
  const hashStore = new HashStore()
  const hashProcessor = new FileHashProcessor(config, hashStore, database)

  const getIpfsVersion = await ipfsClient.version()
  if (!getIpfsVersion.ok) {
    log.fatal('Failed to connect to endpoint', getIpfsVersion.error)
    process.exit(1)
  }

  log.info(`node-ipfs-sync v${config.version} starting up...`)
  const watchdog = new Watchdog(
    config,
    hashStore,
    hashProcessor,
    ipfsClient,
    estuaryClient,
    database
  )
  const watchdogError = await watchdog.start()
  if (watchdogError.hasValue) {
    log.fatal('Watchdog error', watchdogError.value)
    process.exit(1)
  }
}

main().catch((e) => {
  log.fatal('Application crashed', e)
})
