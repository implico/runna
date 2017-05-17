'use strict'

const chalk = require('chalk')
const spawn = require('child_process').spawn
const fs = require('fs')
const minimist = require('minimist')
const mm = require('micromatch')
const path = require('path')
const watch = require('simple-watcher')

const INTERVAL = 300
const WAIT = '-'
const ASNC = '+'
const RNA = chalk.blue('[runna]')
const ERR = chalk.red('[err]')
const LOG = chalk.green('[log]')
const FLV = '$FLV'

class Runner {
  init (args) {
    args = args || {}
    this.cfg = this.getJson(path.join(process.cwd(), 'package.json'))
    this.flavors = typeof args.flavors === 'string' ? args.flavors.split(',') : []
    this.queue = []

    this.getScripts()
    this.getTasks()

    // console.log(JSON.stringify(this.tasks, null, 2))
    // process.exit()
  }

  applyFlavor (string, flavor) {
    return string.replace(new RegExp('\\' + FLV, 'g'), flavor)
  }

  getScripts () {
    this.scripts = {}
    Object.keys(this.cfg.scripts).forEach(scriptName => {
      let script = this.cfg.scripts[scriptName]
      this.scripts[scriptName] = []

      // Non flavored scripts.
      if (!script.includes(FLV) || !this.flavors.length) {
        return this.scripts[scriptName].push({args: this.getSpawnArgs(script)})
      }

      // Flavored scripts
      this.flavors.forEach(flavor => {
        let args = this.getSpawnArgs(this.applyFlavor(script, flavor))
        this.scripts[scriptName].push({args, flavor})
      })
    })
  }

  getTasks () {
    this.tasks = {}
    Object.keys(this.cfg.runna).forEach(taskName => {
      let task = this.cfg.runna[taskName]
      let watch = []
      let chain = typeof task === 'string' ? task : task.chain
      chain = chain.replace(/\s+/, ' ').split(' ')

      // Process watch patterns.
      task.watch && task.watch.forEach(pattern => {
        // Non flavored watch.
        if (!pattern.includes(FLV) || !this.flavors.length) {
          return watch.push({pattern})
        }

        // Flavored watch.
        this.flavors.forEach(flavor => {
          watch.push({pattern: this.applyFlavor(pattern, flavor), flavor})
        })
      })

      this.tasks[taskName] = {chain, watch}
    })
  }

  getJson (filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }

  getSpawnArgs (cmd) {
    let args = cmd.split(' ')
    let packageName = args[0]
    let packagePath = path.join(process.cwd(), 'node_modules', packageName)
    if (!fs.existsSync(packagePath)) {
      return args
    }

    let cfg = this.getJson(path.join(packagePath, 'package.json'))
    if (cfg.bin && Object.keys(cfg.bin).includes(packageName)) {
      args[0] = path.join(process.cwd(), 'node_modules', packageName, cfg.bin[packageName])
      // TODO: Get current Node.js location.
      args.unshift('node')
      return args
    }

    return args
  }

  getLogLines (buf, name) {
    return buf.toString('utf8').replace(/[\r|\n]+$/, '').split('\n').map(line => `${chalk.blue('[' + name + ']')} ${line}\n`)
  }

  runScript (scriptName, flavors) {
    // Check if script exists.
    let script = this.scripts[scriptName]
    if (!script) {
      console.log(`${RNA} ${ERR} Script does not exist: ${scriptName}`)
      return new Promise((resolve, reject) => resolve())
    }

    let pipeline = []
    script.forEach(s => {
      if (!s.flavor || flavors.includes(s.flavor)) {
        let name = s.flavor ? `${scriptName}:${s.flavor}` : scriptName
        pipeline.push(this.runArgs(s.args, name))
      }
    })

    return Promise.all(pipeline)
  }

  runArgs (args, name) {
    return new Promise((resolve, reject) => {
      // Prepare.
      let done
      let timestamp = Date.now()
      let end = callback => {
        if (!done) {
          let duration = Date.now() - timestamp
          console.log(`${RNA} ${LOG} Script ended in ${duration} ms: ${name}`)
          done = resolve()
        }
      }

      // Spawn child process.
      console.log(`${RNA} ${LOG} Script started: ${name}`)
      let child = spawn(args[0], args.slice(1))

      // Resolve on proper close.
      child.on('close', code => {
        code === 0 && end()
      })

      // Reject on error.
      child.on('error', err => {
        console.error(err)
        end()
      })

      // Capture stdout.
      child.stdout.on('data', buf => {
        this.getLogLines(buf, name).forEach(line => process.stdout.write(line))
      })

      // Capture stderr.
      child.stderr.on('data', buf => {
        this.getLogLines(buf, name).forEach(line => process.stderr.write(line))
      })
    })
  }

  runTask (taskName, flavors) {
    flavors = flavors || this.flavors
    return new Promise((resolve, reject) => {
      // Get the chain.
      let task = this.tasks[taskName]
      if (!task) {
        console.error(`${RNA} ${ERR} Task does not exist: ${taskName}`)
        return resolve()
      }

      // Run chain.
      console.log(`${RNA} ${LOG} Running task: ${taskName}`)
      this.runChain(task.chain, flavors, () => resolve())
    })
  }

  runChain (chain, flavors, callback) {
    // Get all scripts up to the wait.
    let current = []
    let remaining = []
    for (let ii = 0; ii < chain.length; ++ii) {
      // Run async scripts.
      if (chain[ii].startsWith(ASNC)) {
        this.runScript(chain[ii].substr(1), flavors)
        continue
      }

      // Stop at wait scripts.
      if (chain[ii].startsWith(WAIT)) {
        remaining = chain.slice(ii)
        remaining[0] = remaining[0].substr(1)
        break
      }

      current.push(chain[ii])
    }

    // Fire callback when nothing to process.
    if (!current.length && !remaining.length) {
      return callback && callback()
    }

    // Execute all current scripts.
    current.length && Promise
      .all(current.map(script => this.runScript(script, flavors)))
      .then(() => {
        // Execute all remaining when current end.
        this.runChain(remaining, flavors, callback)
      })
  }

  watch () {
    watch(process.cwd(), localPath => this.queue.push(localPath))
  }

  work () {
    console.log(`${RNA} ${LOG} Watching for changes ...`)
    if (!this.worker) {
      this.worker = setInterval(this.processQueue.bind(this), INTERVAL)
    }
  }

  processQueue () {
    // Wait for the previous task to complete to avoid concurrency conflicts.
    if (this.lock) {
      return
    }

    // Get unique list of local paths.
    let dict = {}
    while (this.queue.length > 0) {
      dict[this.queue.pop()] = true
    }

    // Get all the items.
    let paths = Object.keys(dict).map(localPath => {
      return localPath.replace(/\\/g, '/').substr(process.cwd().length + 1)
    })

    if (paths.length === 0) {
      return // Skip if no unique paths.
    }

    this.processPaths(paths)
  }

  processPaths (paths) {
    // Get the pipeline.
    let pipeline = []
    Object.keys(this.tasks).forEach(taskName => {
      let task = this.tasks[taskName]

      // Get the flavors that match the pattern.
      let flavors = new Set()
      task.watch.some(w => {
        let match = mm(paths, w.pattern)

        // Continue if no match.
        if (match.length === 0) {
          return
        }

        // Add all flavors if generic.
        if (!w.flavor) {
          flavors = new Set(this.flavors)
          return true
        }

        // Add matched flavor.
        flavors.add(w.flavor)
      })

      // Add task to pipeline.
      if (flavors.size > 0) {
        this.lock = true
        pipeline.push(this.runTask(taskName, [...flavors]))
      }
    })

    // Wait for the pipeline to process and unlock.
    if (pipeline.length > 0) {
      Promise.all(pipeline).then(() => {
        this.lock = false
      })
    }
  }

  handleExit () {
    let handler = () => {
      console.log(`${RNA} ${LOG} Shutting down.`)
      process.exit()
    }

    process.on('SIGINT', handler)
  }

  main () {
    let args = minimist(process.argv.slice(3))
    this.init({flavors: args.f})

    args.w && this.watch()
    this.runTask(process.argv[2]).then(() => {
      args.w && this.work()
    })
  }
}

if (require.main === module) {
  let runner = new Runner()
  runner.main()
}

module.exports = Runner
