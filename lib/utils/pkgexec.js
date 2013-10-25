module.exports = pkgexec;

var npm = require("../npm.js")
  , log = require("npmlog")
  , fs = require('fs')
  , path = require('path')
  , chain = require("slide").chain
  , spawn = require("child_process").spawn
  , Stream = require("stream").Stream
  , PATH = "PATH"

// windows calls it's path "Path" usually, but this is not guaranteed.
if (process.platform === "win32") {
  PATH = "Path"
  Object.keys(process.env).forEach(function (e) {
    if (e.match(/^PATH$/i)) {
      PATH = e
    }
  })
}

function pkgexec(sh, args, pkg, wd, env_vars, cb) {
  if (typeof cb !== "function") cb = env_vars, env_vars = {}

  pkgexec_(wd, sh, args, pkg, env_vars, cb)
}

function pkgexec_(wd, shell_command, args, pkg, env_vars, cb) {
  var pathArr = []
    , p = wd.split("node_modules")
    , acc = path.resolve(p.shift())

  // set the env variables, then run scripts as a child process.
  var env = makeEnv(pkg)

  // allow to pass env variables from outer code
  for (var i in env_vars) {
    env[i] = env_vars[i]
  }

  env.npm_node_execpath = env.NODE = env.NODE || process.execPath
  env.npm_execpath = require.main.filename

  // "nobody" typically doesn't have permission to write to /tmp
  // even if it's never used, sh freaks out.
  if (!npm.config.get("unsafe-perm")) env.TMPDIR = wd

  // first add the directory containing the `node` executable currently
  // running, so that any lifecycle script that invoke "node" will execute
  // this same one.
  pathArr.unshift(path.dirname(process.execPath))

  p.forEach(function (pp) {
    pathArr.unshift(path.join(acc, "node_modules", ".bin"))
    acc = path.join(acc, "node_modules", pp)
  })
  pathArr.unshift(path.join(acc, "node_modules", ".bin"))

  // we also unshift the bundled node-gyp-bin folder so that
  // the bundled one will be used for installing things.
  pathArr.unshift(path.join(__dirname, "..", "..", "bin", "node-gyp-bin"))

  if (env[PATH]) pathArr.push(env[PATH])
  env[PATH] = pathArr.join(process.platform === "win32" ? ";" : ":")

  chain
    ( [
        [runCommand, wd, shell_command, args, env, pkg]
      , env.npm_lifecycle_event &&
        [runHookLifecycle, env.npm_lifecycle_event, pkg, env, wd]
      ]
    , cb )
}

function runCommand(wd, command, args, env, pkg, cb) {
  var sh = "sh"
    , shFlag = "-c"
    , cmd
    , cmdArgs

  if (process.platform === "win32") {
    sh = "cmd"
    shFlag = "/c"
  }

  var note = "\n> " + pkg._id + " " + command + " " + wd
           + "\n> " + command + ' ' + args.join(' ') + "\n"

  console.log(note)

  cmd = [command].concat(args).join(' ')

  cmdArgs = [shFlag, cmd]

  var conf = { cwd: wd, env: process.env, customFds: [ 0, 1, 2] }
  var proc = spawn(sh, cmdArgs, conf)
  proc.on("close", function (er, stdout, stderr) {
    if (er && !npm.ROLLBACK) {
      log.info(pkg._id, "Failed to exec "+command+" script")
      er.message = pkg._id + " "
                  + command + ": `" + cmd
                  + er.message
      if (er.code !== "EPERM") {
        er.code = "ELIFECYCLE"
      }
      er.pkgid = pkg._id
      er.script = env.command
      er.pkgname = pkg.name
      return cb(er)
    } else if (er) {
      log.error(pkg._id+"."+command, er)
      log.error(pkg._id+"."+command, "continuing anyway")
      return cb()
    }
    cb(er)
  })
}

function makeEnv (data, prefix, env) {
  prefix = prefix || "npm_package_"
  if (!env) {
    env = {}
    for (var i in process.env) if (!i.match(/^npm_/)) {
      env[i] = process.env[i]
    }

    // npat asks for tap output
    if (npm.config.get("npat")) env.TAP = 1

    // express and others respect the NODE_ENV value.
    if (npm.config.get("production")) env.NODE_ENV = "production"

  } else if (!data.hasOwnProperty("_lifecycleEnv")) {
    Object.defineProperty(data, "_lifecycleEnv",
      { value : env
      , enumerable : false
      })
  }

  for (var i in data) if (i.charAt(0) !== "_") {
    var envKey = (prefix+i).replace(/[^a-zA-Z0-9_]/g, '_')
    if (i === "readme") {
      continue
    }
    if (data[i] && typeof(data[i]) === "object") {
      try {
        // quick and dirty detection for cyclical structures
        JSON.stringify(data[i])
        makeEnv(data[i], envKey+"_", env)
      } catch (ex) {
        // usually these are package objects.
        // just get the path and basic details.
        var d = data[i]
        makeEnv( { name: d.name, version: d.version, path:d.path }
               , envKey+"_", env)
      }
    } else {
      env[envKey] = String(data[i])
      env[envKey] = -1 !== env[envKey].indexOf("\n")
                  ? JSON.stringify(env[envKey])
                  : env[envKey]
    }

  }

  if (prefix !== "npm_package_") return env

  prefix = "npm_config_"
  var pkgConfig = {}
    , keys = npm.config.keys
    , pkgVerConfig = {}
    , namePref = data.name + ":"
    , verPref = data.name + "@" + data.version + ":"

  keys.forEach(function (i) {
    if (i.charAt(0) === "_" && i.indexOf("_"+namePref) !== 0) {
      return
    }
    var value = npm.config.get(i)
    if (value instanceof Stream || Array.isArray(value)) return
    if (!value) value = ""
    else if (typeof value !== "string") value = JSON.stringify(value)

    value = -1 !== value.indexOf("\n")
          ? JSON.stringify(value)
          : value
    i = i.replace(/^_+/, "")
    if (i.indexOf(namePref) === 0) {
      var k = i.substr(namePref.length).replace(/[^a-zA-Z0-9_]/g, "_")
      pkgConfig[ k ] = value
    } else if (i.indexOf(verPref) === 0) {
      var k = i.substr(verPref.length).replace(/[^a-zA-Z0-9_]/g, "_")
      pkgVerConfig[ k ] = value
    }
    var envKey = (prefix+i).replace(/[^a-zA-Z0-9_]/g, "_")
    env[envKey] = value
  })

  prefix = "npm_package_config_"
  ;[pkgConfig, pkgVerConfig].forEach(function (conf) {
    for (var i in conf) {
      var envKey = (prefix+i)
      env[envKey] = conf[i]
    }
  })

  return env
}

function runHookLifecycle (stage, pkg, env, wd, cb) {
  // check for a hook script, run if present.
  var hook = path.join(npm.dir, ".hooks", stage)
    , cmd = hook

  fs.stat(hook, function (er) {
    if (er) return cb()

    var conf = { cwd: wd, env: env, customFds: [ 0, 1, 2] }
    var proc = spawn("sh", ["-c", cmd], conf)
    proc.on("close", function (er) {
      if (er) {
        er.message += "\nFailed to exec "+stage+" hook script"
        log.info(pkg._id, er)
      }
      if (npm.ROLLBACK) return cb()
      cb(er)
    })
  })
}