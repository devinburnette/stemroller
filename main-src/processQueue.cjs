const os = require('os')
const fs = require('fs/promises')
const { createWriteStream } = require('fs')
const { pipeline } = require('stream/promises')
const path = require('path')
const childProcess = require('child_process')
const treeKill = require('tree-kill')
const ytdl = require('@distube/ytdl-core')
const sanitizeFilename = require('sanitize-filename')
const { powerSaveBlocker } = require('electron')

let statusUpdateCallback = null,
  donateUpdateCallback = null
let curItems = [],
  curChildProcess = null,
  curYtdlAbortController = null

function getPathToThirdPartyApps() {
  if (process.env.NODE_ENV === 'dev') {
    if (process.platform === 'win32') {
      return path.resolve(path.join(__dirname, '..', 'win-extra-files', 'ThirdPartyApps'))
    } else if (process.platform === 'darwin') {
      return path.resolve(path.join(__dirname, '..', 'mac-extra-files', 'ThirdPartyApps'))
    } else {
      return null
    }
  } else {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return path.resolve(path.join(process.resourcesPath, '..', 'ThirdPartyApps'))
    } else {
      return null
    }
  }
}

function getPathToModels() {
  if (process.env.NODE_ENV === 'dev') {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return path.resolve(path.join(__dirname, '..', 'anyos-extra-files', 'Models'))
    } else {
      return null
    }
  } else {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return path.resolve(path.join(process.resourcesPath, '..', 'Models'))
    } else {
      return null
    }
  }
}

const PATH_TO_THIRD_PARTY_APPS = getPathToThirdPartyApps()
const PATH_TO_MODELS = getPathToModels()
const PATH_TO_DEMUCS = PATH_TO_THIRD_PARTY_APPS
  ? path.join(PATH_TO_THIRD_PARTY_APPS, 'demucs-cxfreeze')
  : null
const PATH_TO_FFMPEG = PATH_TO_THIRD_PARTY_APPS
  ? path.join(PATH_TO_THIRD_PARTY_APPS, 'ffmpeg', 'bin')
  : null
const DEMUCS_EXE_NAME = PATH_TO_THIRD_PARTY_APPS ? 'demucs-cxfreeze' : 'demucs'
const FFMPEG_EXE_NAME = 'ffmpeg'
const CHILD_PROCESS_ENV = {
  CUDA_PATH: process.env.CUDA_PATH,
  PATH: process.env.PATH,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
}
if (PATH_TO_THIRD_PARTY_APPS) {
  // Override the system's PATH with the path to our own bundled third-party apps
  CHILD_PROCESS_ENV.PATH =
    PATH_TO_DEMUCS + (process.platform === 'win32' ? ';' : ':') + PATH_TO_FFMPEG
}
const DEMUCS_MODEL_NAME = 'htdemucs_ft'
const TMP_PREFIX = 'StemRoller-'

function getJobCount() {
  const MAX_NUM_JOBS = 4
  const numMemories = Math.floor(os.freemem() / 2000000000) // Need approximately 2GB per track
  const numCpus = os.cpus().length
  return Math.max(1, Math.min(Math.min(numCpus, numMemories), MAX_NUM_JOBS))
}

function killCurChildProcess() {
  if (curYtdlAbortController) {
    console.log('Aborting ytdl pipeline')
    curYtdlAbortController.abort()
    curYtdlAbortController = null
  }

  if (curChildProcess) {
    try {
      console.trace(`treeKill process ${curChildProcess.pid}`)
      treeKill(curChildProcess.pid)
    } catch (err) {
      console.trace(`treeKill failed: ${err}`)
    }
    curChildProcess = null
  }
}

function spawnAndWait(cwd, command, args) {
  return new Promise((resolve, reject) => {
    killCurChildProcess()

    curChildProcess = childProcess.spawn(command, args, {
      cwd,
      env: CHILD_PROCESS_ENV,
    })

    curChildProcess.stdout.on('data', (data) => {
      console.log(`child stdout:\n${data}`)
    })

    curChildProcess.stderr.on('data', (data) => {
      console.log(`child stderr:\n${data}`)
    })

    curChildProcess.on('error', (error) => {
      reject(error)
      killCurChildProcess()
    })

    curChildProcess.on('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Child process exited due to signal: ${signal}`))
      } else {
        resolve(code)
      }
      curChildProcess = null
    })
  })
}

async function asyncYtdl(videoId, downloadPath) {
  curYtdlAbortController = new AbortController()
  const ytdlStream = ytdl(videoId, {
    highWaterMark: 1024 * 1024 * 64,
    quality: 'highestaudio',
  })
  const fileStream = createWriteStream(downloadPath)
  await pipeline(ytdlStream, fileStream, {
    signal: curYtdlAbortController.signal,
  })
  curYtdlAbortController = null
}

async function findDemucsOutputDir(basePath) {
  const entries = await fs.readdir(basePath, {
    withFileTypes: true,
  })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      return path.join(basePath, entry.name)
    }
  }
  throw new Error('Unable to find Demucs output directory')
}

async function ensureFileExists(path) {
  try {
    await fs.access(path)
    return true
  } catch (error) {
    return false
  }
}

async function ensureDemucsPathsExist(paths) {
  for (const i in paths) {
    if (!ensureFileExists(paths[i])) {
      console.trace(`File "${paths[i]}" does not exist`)
      return false
    }
  }
  return true
}

async function _processVideo(video, tmpDir) {
  const beginTime = Date.now()
  console.log(`BEGIN downloading/processing video "${video.videoId}" - "${video.title}"`)
  setVideoStatusAndPath(video.videoId, 'downloading', null)

  let mediaPath = null

  if (video.mediaSource === 'youtube') {
    const ytFilename = 'yt-audio'
    const ytPath = path.join(tmpDir, ytFilename)
    console.log(`Downloading YouTube video "${video.videoId}"; storing in "${ytPath}"`)
    await asyncYtdl(video.videoId, ytPath)
    mediaPath = ytPath
  } else if (video.mediaSource === 'local') {
    mediaPath = video.localInputPath
  } else {
    throw new Error(`Invalid mediaSource: ${video.mediaSource}`)
  }

  setVideoStatusAndPath(video.videoId, 'processing', null)
  const jobCount = getJobCount()
  console.log(
    `Splitting video "${video.videoId}"; ${jobCount} jobs using model "${DEMUCS_MODEL_NAME}"...`
  )
  const demucsExeArgs = [mediaPath, '-n', DEMUCS_MODEL_NAME, '-j', jobCount]
  if (module.exports.getPyTorchBackend() === 'cpu') {
    console.log('Running with "-d cpu" to force CPU instead of CUDA')
    demucsExeArgs.push('-d', 'cpu')
  }
  if (PATH_TO_MODELS) {
    demucsExeArgs.push('--repo', PATH_TO_MODELS)
  }
  await spawnAndWait(tmpDir, DEMUCS_EXE_NAME, demucsExeArgs)

  const demucsBasePath = await findDemucsOutputDir(
    path.join(tmpDir, 'separated', DEMUCS_MODEL_NAME)
  )
  const demucsPaths = {
    bass: path.join(demucsBasePath, 'bass.wav'),
    drums: path.join(demucsBasePath, 'drums.wav'),
    other: path.join(demucsBasePath, 'other.wav'),
    vocals: path.join(demucsBasePath, 'vocals.wav'),
  }

  const demucsSuccess = await ensureDemucsPathsExist(demucsPaths)
  if (!demucsSuccess) {
    throw new Error('Unable to access output stems - Demucs probably failed')
  }

  const instrumentalPath = path.join(tmpDir, 'instrumental.wav')
  console.log(`Mixing down instrumental stems to "${instrumentalPath}"`)
  await spawnAndWait(tmpDir, FFMPEG_EXE_NAME, [
    '-i',
    demucsPaths.bass,
    '-i',
    demucsPaths.drums,
    '-i',
    demucsPaths.other,
    '-filter_complex',
    'amix=inputs=3:normalize=0',
    instrumentalPath,
  ])
  const instrumentalSuccess = await ensureFileExists(instrumentalPath)
  if (!instrumentalSuccess) {
    throw new Error(
      `Unable to access instrumental file "${instrumentalPath}" - ffmpeg probably failed`
    )
  }

  const outputFolderName = sanitizeFilename(`${video.title}-${video.videoId}`)
  const outputBasePath = path.join(module.exports.getOutputPath(), outputFolderName)
  await fs.mkdir(outputBasePath, { recursive: true })
  console.log(`Copying all stems to "${outputBasePath}"`)
  const outputPaths = {
    bass: path.join(outputBasePath, 'bass.wav'),
    drums: path.join(outputBasePath, 'drums.wav'),
    other: path.join(outputBasePath, 'other.wav'),
    vocals: path.join(outputBasePath, 'vocals.wav'),
    instrumental: path.join(outputBasePath, 'instrumental.wav'),
  }

  for (const i in demucsPaths) {
    await fs.copyFile(demucsPaths[i], outputPaths[i])
  }
  await fs.copyFile(instrumentalPath, outputPaths.instrumental)

  const elapsedSeconds = (Date.now() - beginTime) * 0.001
  console.log(
    `DONE processing video "${video.videoId}" - "${video.title}" (finished in ${Math.round(
      elapsedSeconds
    )} seconds`
  )
  setVideoStatusAndPath(video.videoId, 'done', outputBasePath)
}

async function processVideo(video) {
  let powerSaveBlockId = null

  try {
    powerSaveBlockId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('Successfully blocked power-save using policy: "prevent-app-suspension"')
  } catch (err) {
    powerSaveBlockId = null
    console.trace(err)
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX))
  try {
    await _processVideo(video, tmpDir)
  } catch (err) {
    console.trace(err)

    const status = module.exports.getVideoStatus(video.videoId)
    if (status === null) {
      console.log('Task was canceled by user.')
    } else {
      setVideoStatusAndPath(video.videoId, 'error', null)
    }
  } finally {
    try {
      await fs.rm(tmpDir, {
        recursive: true,
        maxRetries: 5,
        retryDelay: 1000,
      })
    } catch (err) {
      console.trace(err)
    }

    // Will filter out the current (completed) video
    module.exports.setItems(curItems)

    if (powerSaveBlockId !== null) {
      try {
        powerSaveBlocker.stop(powerSaveBlockId)
        console.log('Successfully unblocked power-save')
      } catch (err) {
        console.error('Failed to unblock power-save')
        console.trace(err)
      }
      powerSaveBlockId = null
    }
  }
}

module.exports.setItems = async (items) => {
  items = items.filter((video) => {
    let status = module.exports.getVideoStatus(video.videoId)
    if (status === null) {
      status = 'queued'
      setVideoStatusAndPath(video.videoId, status, null)
    }
    return status !== 'done' && status !== 'error'
  })

  const oldVideoId = curItems.length > 0 ? curItems[0].videoId : null
  const newVideoId = items.length > 0 ? items[0].videoId : null
  const interrupt = oldVideoId !== newVideoId

  curItems = items
  if (interrupt) {
    killCurChildProcess()
    if (curItems.length > 0) {
      // Avoid recursion when processVideo calls this function
      setTimeout(() => processVideo(curItems[0]), 0)
    }
  }
}

let electronStore = null
let videosDb = {}

async function loadVideosDb() {
  const loaded = electronStore.get('videosDb') || {}
  const filtered = {}

  for (const videoId in loaded) {
    let exists = false

    try {
      await fs.access(loaded[videoId].path)
      exists = true
    } catch (error) {
      exists = false
    }

    if (exists) {
      filtered[videoId] = loaded[videoId]
    }
  }

  videosDb = filtered
  electronStore.set('videosDb', videosDb)
}

function saveFinishedToVideosDb() {
  let numFinished = 0
  const filtered = {}
  for (const videoId in videosDb) {
    if (videosDb[videoId].status === 'done') {
      filtered[videoId] = videosDb[videoId]
      ++numFinished
    }
  }
  electronStore.set('videosDb', filtered)

  if (numFinished >= 3 && electronStore.get('canShowDonatePopup') !== false) {
    donateUpdateCallback({
      showDonatePopup: true,
    })
  }
}

function setVideoStatusAndPath(videoId, status, path) {
  videosDb[videoId] = {
    status,
    path,
  }
  saveFinishedToVideosDb()

  statusUpdateCallback({
    videoId,
    ...videosDb[videoId],
  })
}

module.exports.setElectronStore = (store) => {
  electronStore = store
  loadVideosDb()
}

module.exports.getOutputPath = () => {
  if (electronStore) {
    const outputPath = electronStore.get('outputPath')
    if (outputPath) {
      return outputPath
    }
  }
  return path.join(os.homedir(), 'Music', 'StemRoller')
}

module.exports.setOutputPath = (outputPath) => {
  electronStore.set('outputPath', outputPath)
}

module.exports.getPyTorchBackend = () => {
  if (electronStore) {
    const backend = electronStore.get('pyTorchBackend')
    if (backend) {
      return backend
    }
  }
  return 'auto'
}

module.exports.setPyTorchBackend = (backend) => {
  electronStore.set('pyTorchBackend', backend)
}

module.exports.getVideoStatus = (videoId) => {
  if (videoId in videosDb) {
    return videosDb[videoId].status
  } else {
    return null
  }
}

module.exports.getVideoPath = (videoId) => {
  if (videoId in videosDb) {
    return videosDb[videoId].path
  } else {
    return null
  }
}

module.exports.deleteVideoStatusAndPath = (videoId) => {
  if (videoId in videosDb) {
    const nulledEntry = videosDb[videoId]
    for (const i in nulledEntry) {
      nulledEntry[i] = null
    }

    delete videosDb[videoId]
    saveFinishedToVideosDb()

    statusUpdateCallback({
      videoId,
      ...nulledEntry,
    })
  }
}

module.exports.isBusy = () => {
  return (
    curItems.filter((video) => {
      const status = module.exports.getVideoStatus(video.videoId)
      return status === 'processing' || status === 'downloading'
    }).length > 0
  )
}

module.exports.registerStatusUpdateCallback = (callback) => {
  statusUpdateCallback = callback
}

module.exports.registerDonateUpdateCallback = (callback) => {
  donateUpdateCallback = callback
}

module.exports.deleteTmpFolders = async () => {
  const tmpBasePath = os.tmpdir()
  const items = await fs.readdir(tmpBasePath)
  for (const itemName of items) {
    if (itemName.indexOf(TMP_PREFIX) === 0) {
      try {
        const itemPath = path.join(tmpBasePath, itemName)
        await fs.rm(itemPath, {
          recursive: true,
          maxRetries: 5,
          retryDelay: 1000,
        })
        console.log(`Deleted temporary folder "${itemPath}"`)
      } catch (error) {
        console.trace(error)
      }
    }
  }
}
