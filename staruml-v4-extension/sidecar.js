'use strict'

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const HOST = process.env.MCP_BRIDGE_HOST || '127.0.0.1'
const PORT = Number(process.env.MCP_BRIDGE_PORT || 58321)
const MAX_BODY_SIZE = 1024 * 1024
const REQUEST_TIMEOUT_MS = Number(
  process.env.MCP_BRIDGE_REQUEST_TIMEOUT_MS || 120000
)
const RESPONSE_POLL_MS = 10
const RESPONSE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'staruml-mcp-bridge-')
)
const DIAGNOSTIC_LOG = path.join(
  os.tmpdir(),
  'staruml-mcp-bridge-v4-' + process.pid + '.log'
)

let nextRequestId = 0
let shuttingDown = false
const pending = new Map()

function removeRequestFiles (id) {
  const dataPath = path.join(RESPONSE_DIR, id + '.request.data')
  const readyPath = path.join(RESPONSE_DIR, id + '.request.ready')
  try {
    if (fs.existsSync(readyPath)) fs.unlinkSync(readyPath)
    if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath)
  } catch (error) {}
}

function trace (event, details) {
  const line = new Date().toISOString() +
    ' [sidecar pid=' + process.pid + '] ' + event +
    (details ? ' ' + details : '')
  try {
    fs.appendFileSync(DIAGNOSTIC_LOG, line + '\r\n', 'utf8')
  } catch (error) {}
  console.log('[TRACE] ' + line)
}

function failure (message) {
  return { success: false, error: message }
}

function sendJson (res, status, payload, durationMs, requestId) {
  if (res.writableEnded) return

  const json = JSON.stringify(payload)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Connection': 'close'
  }

  if (Number.isFinite(durationMs)) {
    headers['X-MCP-Bridge-Duration-Ms'] = String(durationMs)
  }

  trace(
    'HTTP_RESPONSE_WRITE_START',
    'id=' + (requestId || '-') +
    ' status=' + status + ' bytes=' + Buffer.byteLength(json)
  )
  res.once('finish', function () {
    trace('HTTP_RESPONSE_FINISHED', 'id=' + (requestId || '-'))
  })
  res.once('close', function () {
    trace(
      'HTTP_RESPONSE_CLOSED',
      'id=' + (requestId || '-') + ' writableEnded=' + res.writableEnded
    )
  })
  res.writeHead(status, headers)
  res.end(json)
}

function sendToParent (message, onError) {
  if (!process.connected) return false
  try {
    process.send(message, function (error) {
      if (error && typeof onError === 'function') onError(error)
    })
    return true
  } catch (error) {
    if (typeof onError === 'function') onError(error)
    return false
  }
}

const httpServer = http.createServer(function (req, res) {
  trace(
    'HTTP_REQUEST_RECEIVED',
    'method=' + req.method + ' path=' + req.url +
    ' remote=' + req.socket.remoteAddress + ':' + req.socket.remotePort
  )
  if (req.method !== 'POST') {
    sendJson(res, 405, failure('Only POST requests are supported.'))
    return
  }

  const chunks = []
  let size = 0

  req.on('data', function (chunk) {
    size += chunk.length
    if (size <= MAX_BODY_SIZE) chunks.push(chunk)
  })

  req.on('end', function () {
    trace('HTTP_REQUEST_BODY_COMPLETE', 'path=' + req.url + ' bytes=' + size)
    if (size > MAX_BODY_SIZE) {
      sendJson(res, 413, failure('Request body is too large.'))
      return
    }

    let body
    try {
      body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : {}
    } catch (error) {
      sendJson(res, 400, failure('Invalid JSON request body.'))
      return
    }

    if (!process.connected) {
      sendJson(res, 503, failure('StarUML bridge is disconnected.'))
      return
    }

    const id = String(++nextRequestId)
    trace('REQUEST_ASSIGNED', 'id=' + id + ' path=' + req.url)
    const timeout = setTimeout(function () {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      removeRequestFiles(id)
      trace('REQUEST_TIMEOUT', 'id=' + id)
      sendJson(
        entry.res,
        504,
        failure('StarUML did not respond within ' + REQUEST_TIMEOUT_MS + 'ms.'),
        undefined,
        id
      )
    }, REQUEST_TIMEOUT_MS)

    pending.set(id, { res: res, timeout: timeout })
    res.once('close', function () {
      if (res.writableEnded) return
      const entry = pending.get(id)
      if (entry) clearTimeout(entry.timeout)
      pending.delete(id)
      removeRequestFiles(id)
    })

    const requestMessage = {
      type: 'request',
      id: id,
      path: req.url.split('?')[0],
      body: body
    }

    const requestDataPath = path.join(RESPONSE_DIR, id + '.request.data')
    const requestReadyPath = path.join(RESPONSE_DIR, id + '.request.ready')

    try {
      trace('REQUEST_MAILBOX_WRITE_START', 'id=' + id + ' path=' + requestDataPath)
      fs.writeFileSync(requestDataPath, JSON.stringify(requestMessage), 'utf8')
      fs.writeFileSync(requestReadyPath, '', 'utf8')
      trace('REQUEST_MAILBOX_WRITE_DONE', 'id=' + id)
    } catch (error) {
      clearTimeout(timeout)
      pending.delete(id)
      removeRequestFiles(id)
      trace(
        'REQUEST_MAILBOX_WRITE_FAILED',
        'id=' + id + ' error=' + (error.stack || error.message || error)
      )
      sendJson(res, 503, failure('Could not send the request to StarUML.'))
    }
  })
})

httpServer.keepAliveTimeout = 1000
httpServer.headersTimeout = 5000

function handleParentResponse (message) {
  if (!message || message.type !== 'response') return
  const entry = pending.get(String(message.id))
  if (!entry) {
    trace('MAILBOX_RESPONSE_ORPHANED', 'id=' + message.id)
    return
  }

  clearTimeout(entry.timeout)
  pending.delete(String(message.id))
  trace(
    'MAILBOX_RESPONSE_ACCEPTED',
    'id=' + message.id + ' status=' + (message.status || 200)
  )
  sendJson(
    entry.res,
    message.status || 200,
    message.payload,
    message.durationMs,
    String(message.id)
  )
}

// StarUML 4's Electron renderer can receive child IPC immediately, but its
// writes back to a child process may stay buffered until shutdown. Polling
// atomic response files keeps that broken outbound event loop out of the path.
const responsePollTimer = setInterval(function () {
  const shutdownPath = path.join(RESPONSE_DIR, 'shutdown')
  if (fs.existsSync(shutdownPath)) {
    shutdown()
    return
  }

  pending.forEach(function (entry, id) {
    const responseDataPath = path.join(RESPONSE_DIR, id + '.data')
    const responseReadyPath = path.join(RESPONSE_DIR, id + '.ready')
    if (!fs.existsSync(responseReadyPath)) return

    try {
      trace(
        'MAILBOX_READY_DETECTED',
        'id=' + id + ' dataPath=' + responseDataPath
      )
      const message = JSON.parse(fs.readFileSync(responseDataPath, 'utf8'))
      trace('MAILBOX_DATA_READ', 'id=' + id)
      fs.unlinkSync(responseReadyPath)
      fs.unlinkSync(responseDataPath)
      handleParentResponse(message)
    } catch (error) {
      console.error('[MCP Bridge sidecar] Invalid response file:', error.message)
    }
  })
}, RESPONSE_POLL_MS)

function removeResponseDirectory () {
  try {
    fs.readdirSync(RESPONSE_DIR).forEach(function (name) {
      fs.unlinkSync(path.join(RESPONSE_DIR, name))
    })
    fs.rmdirSync(RESPONSE_DIR)
  } catch (error) {}
}

function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  trace('SHUTDOWN_STARTED', 'pending=' + pending.size)
  clearInterval(heartbeatTimer)
  clearInterval(responsePollTimer)

  pending.forEach(function (entry) {
    clearTimeout(entry.timeout)
    sendJson(entry.res, 503, failure('StarUML bridge stopped.'))
  })
  pending.clear()

  httpServer.close(function () {
    removeResponseDirectory()
    process.exit(0)
  })

  setTimeout(function () {
    process.exit(0)
  }, 1000).unref()
}

const heartbeatTimer = setInterval(function () {
  sendToParent({ type: 'heartbeat', at: Date.now() })
}, 500)

process.on('disconnect', shutdown)

httpServer.on('error', function (error) {
  trace('HTTP_SERVER_ERROR', 'error=' + (error.stack || error.message || error))
  sendToParent({ type: 'fatal', error: error.message || String(error) })
  process.exit(1)
})

httpServer.listen(PORT, HOST, function () {
  trace(
    'HTTP_SERVER_LISTENING',
    'url=http://' + HOST + ':' + PORT +
    ' responseDir=' + RESPONSE_DIR +
    ' diagnosticLog=' + DIAGNOSTIC_LOG
  )
  sendToParent({
    type: 'ready',
    host: HOST,
    port: PORT,
    responseDir: RESPONSE_DIR,
    diagnosticLog: DIAGNOSTIC_LOG
  })
})
