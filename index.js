'use strict'

const chalk = require('chalk')
const fs = require('fs')
const path = require('path')
const watch = require('simple-watcher')
const subarg = require('subarg')
const minimatch = require('minimatch')
const log = require('./lib/log').getInstance()
const Script = require('./lib/script')

const CHILD_EXIT_WAIT = 50
const FILE_WATCH_WAIT = 300
const HELP = `
Usage:
  runna <chain> [options]

Options:
  -p <projects>            Run with projects; a comma separated list.
  -w [<path-to-watch>]     Default is current.
  -v                       Verbose mode (debug).
`

// Serously, this should be the default.
process.on('unhandledRejection', reason => console.error(reason))

class Runner {
  static async main () {
    const runner = new Runner()
    const version = runner.getJson(path.join(__dirname, 'package.json')).version
    console.log(`Runna version ${version}.`)

    const args = subarg(process.argv.slice(2))
    if (!args['_'] || args['_'].length === 0 || !args['_'][0]['_'] || args['_'][0]['_'].length === 0) {
      console.log(HELP)
      process.exit(0)
    }

    const chain = args['_'][0]['_'].join(' ')
    const pathToWatch = (args.w === true && process.cwd()) || (typeof args.w === 'string' && path.resolve(args.w))
    const projects = args.p ? args.p.trim().split(',') : []

    ;(args.d || args.v) && log.enableDebug()
    runner.init(chain, projects, pathToWatch)
  }

  async init (chain, projects, pathToWatch) {
    this.cfg = this.getCfg()
    this.queue = []
    this.pipeline = [] // List of Script objects.

    await this.runChain(chain, [], projects)
    if (pathToWatch) {
      this.observe(pathToWatch, projects)
    } else {
      log.end()
    }
  }

  //
  // Chain processing.
  //

  // chain ~ '+foo - bar baz'
  async runChain (chain, files = [], projects = [], exitOnError = true) {
    const timestamp = Date.now()

    this.removeCompletedScriptsFromPipeline()

    // Add scripts to pipeline.
    files.length === 0 && files.push('')
    for (const name of chain.split(' ')) {
      const code = this.cfg.scripts[name.replace(/[+]*(.*)/g, '$1')] // Name without '+'.
      for (const script of Script.getInstances(name, code, files, projects)) {
        this.pipeline.push(script)
      }
    }

    // Run all the scripts in a chain.
    let msg = projects.length ? `${chalk.magenta(chain)} :: ${chalk.magenta(projects)}` : chalk.magenta(chain)
    log.dbg('runna', `Chain ${msg} started.`)
    for (const script of this.pipeline) {
      await this.startScript(script, exitOnError)
    }

    // Finalize.
    await this.waitForAllChildrenToComplete()
    const duration = Date.now() - timestamp
    log.dbg('runna', `Chain ${msg} completed in ${duration} ms.`)
  }

  async startScript (script, exitOnError) {
    script.start(this.cfg.binaries, () => {
      this.updateStatus()
      script.hasFailed() && this.handleScriptError(exitOnError)
    })
    this.updateStatus()

    if (script.isPause()) {
      await this.waitForAllChildrenToComplete()
      script.end()
    }
  }

  async waitForAllChildrenToComplete () {
    log.dbg('runna', `Waiting for all running scripts to complete...`)
    while (this.pipeline.filter(s => s.isRunning() && !s.isPause() && !s.isBackground()).length !== 0) {
      await this.wait(CHILD_EXIT_WAIT)
    }
  }

  removeCompletedScriptsFromPipeline () {
    for (let ii = this.pipeline.length - 1; ii >= 0; --ii) {
      if (this.pipeline[ii].hasEnded()) {
        this.pipeline.splice(ii, 1)
      }
    }
  }

  handleScriptError (exitOnError) {
    if (exitOnError) {
      log.dbg('runna', `Shutting down.`)
      log.end()
      process.exitCode = 1
      process.exit(1)
    }
  }

  //
  // Watching.
  //

  async observe (pathToWatch, projects) {
    // Get rules: [{
    //   chain: '+foo - bar baz'
    //   pattern: 'c:/absolute/path/to/red/**'
    //   projects: ['red']
    // },{
    //   chain: '+foo - bar baz'
    //   pattern: 'c:/absolute/path/to/blue/**'
    //   projects: [blue']
    // },{
    //   chain: '+foo - bar baz'
    //   pattern: 'c:/absolute/path/to/base/**'
    //   projects: ['red', 'blue']
    // }]
    const rules = []
    for (const [chain, patterns] of Object.entries(this.cfg.observe)) {
      for (let pattern of patterns) {
        // Align with directory structure and normalize slashes.
        pattern = path.resolve(pathToWatch, pattern).replace(/\\/g, '/')

        // Non-project pattern means all the projects apply.
        if (!pattern.includes('$PROJ')) {
          rules.push({chain, pattern, projects})
          continue
        }
        // Add rule for each project separately.
        for (const project of projects) {
          rules.push({chain, pattern: pattern.replace(/\$PROJ/g, project), projects: [project]})
        }
      }
    }

    // Initialize queue.
    this.queue = []
    const waitMsg = `Watching ${chalk.yellow(pathToWatch)} for changes...`
    log.dbg('runna', waitMsg)
    watch(pathToWatch, localPath => this.queue.push(localPath))

    // Main loop.
    while (true) {
      if (await this.processQueue(rules)) {
        log.dbg('runna', waitMsg)
      }
      await this.wait(FILE_WATCH_WAIT)
    }
  }

  async processQueue (rules) {
    if (this.lock || this.queue.length === 0) {
      return
    }

    this.lock = true

    // Dequeue items and normalize slashes.
    const paths = Array.from(new Set(this.queue.splice(0))).map(p => p.replace(/\\/g, '/'))

    // Iterate over changes and look for a match.
    const chainsToRun = {} // {projects: <>, files: []}
    const loggedChanges = new Set()
    for (const rule of rules) {
      const match = this.match(paths, rule.pattern)
      if (match.length === 0) {
        continue
      }

      // Add entry if it does not exist.
      chainsToRun[rule.chain] = chainsToRun[rule.chain] || {projects: new Set(), files: new Set()}

      // Add projects to entry.
      for (const project of rule.projects) {
        chainsToRun[rule.chain].projects.add(project)
      }

      // Add files to entry.
      for (const m of match) {
        // Make sure each change that triggers a script is logged only once.
        if (!loggedChanges[m]) {
          log.dbg('runna', `Changed ${chalk.yellow(path.resolve(m))}`)
          loggedChanges.add(m)
        }
        chainsToRun[rule.chain].files.add(m)
      }
    }

    const any = Object.keys(chainsToRun).length > 0
    for (const [chain, item] of Object.entries(chainsToRun)) {
      await this.runChain(chain, Array.from(item.files), Array.from(item.projects), false)
    }

    this.lock = false
    return any
  }

  //
  // Helpers.
  //

  getJson (filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }

  resolveLocalBinaries (cfg) {
    cfg.binaries = {}

    const binPath = path.resolve(process.cwd(), 'node_modules', '.bin')
    for (const script of fs.readdirSync(binPath)) {
      const scriptPath = path.resolve(binPath, script)
      if (process.platform === 'win32' && script.endsWith('.cmd')) {
        cfg.binaries[script.slice(0, -4)] = scriptPath
      } else {
        cfg.binaries[script] = path.resolve(binPath, script)
      }
    }

    return cfg
  }

  getCfg () {
    const cfg = this.getJson(path.join(process.cwd(), 'package.json'))
    cfg.projects = cfg.projects || {}
    return this.resolveLocalBinaries(cfg)
  }

  getLogLines (buf, name, log) {
    const trimmed = buf.toString('utf8').trim()
    return trimmed ? trimmed.split('\n').map(line => `${chalk.blue(name)} ${log} ${line}\n`) : []
  }

  async wait (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  match (paths, pattern) {
    return minimatch.match(paths, pattern)
  }

  updateStatus () {
    let isRunning = false
    let duration = 0
    const arr = []

    arr.push('[')
    for (const script of this.pipeline) {
      isRunning = isRunning || (!script.isBackground() && !script.hasEnded())
      duration += script.duration
      script.hasEnded() && script.hasFailed() && arr.push(chalk.red(script.name))
      script.hasEnded() && !script.hasFailed() && arr.push(chalk.green(script.name))
      script.isRunning() && arr.push(chalk.white(script.name))
      !script.hasEnded() && !script.isRunning() && arr.push(chalk.gray(script.name))
    }
    arr.push(']')

    isRunning && arr.push('Processing... ')
    !isRunning && arr.push(`Completed in ${Math.round(duration / 10) / 100} seconds. `)

    log.printStatus(arr.join(' '))
  }
}

if (require.main === module) {
  Runner.main()
}

module.exports = Runner
