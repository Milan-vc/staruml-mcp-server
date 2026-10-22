/* global app, type */

const path = require('path')
const fs = require('fs')
const childProcess = require('child_process')

const HOST = '127.0.0.1'
const DEFAULT_PORT = 58321
let server = null
let currentPort = null
let bridgeWebContents = null
let previousBackgroundThrottling = null
let powerSaveBlockerId = null
let backgroundThrottlingDisabled = false

function bridgeTrace (child, event, details) {
  const line = new Date().toISOString() +
    ' [renderer pid=' + process.pid + '] ' + event +
    (details ? ' ' + details : '')
  console.log('[MCP Bridge trace] ' + line)

  if (child && child.mcpDiagnosticLog) {
    try {
      fs.appendFileSync(child.mcpDiagnosticLog, line + '\r\n', 'utf8')
    } catch (error) {
      console.error('[MCP Bridge trace] Could not append diagnostic log:', error)
    }
  }
}

function disableBackgroundThrottling () {
  try {
    const electron = require('electron')
    if (electron.remote) {
      bridgeWebContents = electron.remote.getCurrentWebContents
        ? electron.remote.getCurrentWebContents()
        : null

      if (!bridgeWebContents && electron.remote.getCurrentWindow) {
        const currentWindow = electron.remote.getCurrentWindow()
        bridgeWebContents = currentWindow ? currentWindow.webContents : null
      }

      if (
        bridgeWebContents &&
        typeof bridgeWebContents.setBackgroundThrottling === 'function'
      ) {
        previousBackgroundThrottling = typeof bridgeWebContents.getBackgroundThrottling === 'function'
          ? bridgeWebContents.getBackgroundThrottling()
          : true
        bridgeWebContents.setBackgroundThrottling(false)
        backgroundThrottlingDisabled = typeof bridgeWebContents.getBackgroundThrottling === 'function'
          ? bridgeWebContents.getBackgroundThrottling() === false
          : true
      }

      if (
        electron.remote.powerSaveBlocker &&
        typeof electron.remote.powerSaveBlocker.start === 'function'
      ) {
        powerSaveBlockerId = electron.remote.powerSaveBlocker.start('prevent-app-suspension')
      }
    }

    console.log(
      '[MCP Bridge V4] Background throttling disabled: ' +
      backgroundThrottlingDisabled
    )
    return backgroundThrottlingDisabled
  } catch (error) {
    console.warn('[MCP Bridge V4] Could not disable background throttling:', error)
  }

  console.warn('[MCP Bridge V4] Electron background throttling remains enabled')
  return false
}

function restoreBackgroundBehavior () {
  try {
    const electron = require('electron')
    if (
      bridgeWebContents &&
      previousBackgroundThrottling !== null &&
      typeof bridgeWebContents.setBackgroundThrottling === 'function'
    ) {
      bridgeWebContents.setBackgroundThrottling(previousBackgroundThrottling)
    }
    if (
      powerSaveBlockerId !== null &&
      electron.remote &&
      electron.remote.powerSaveBlocker &&
      typeof electron.remote.powerSaveBlocker.stop === 'function'
    ) {
      electron.remote.powerSaveBlocker.stop(powerSaveBlockerId)
    }
  } catch (error) {
    console.warn('[MCP Bridge V4] Could not restore background behavior:', error)
  }

  bridgeWebContents = null
  previousBackgroundThrottling = null
  powerSaveBlockerId = null
  backgroundThrottlingDisabled = false
}

let Blocked = false

function success (data) {
  return { success: true, data: data }
}

function failure (message) {
  return { success: false, error: message }
}

function elementType (element) {
  return element && element.getClassName
    ? element.getClassName()
    : (element && element.constructor ? element.constructor.name : 'Unknown')
}

function modelSummary (model) {
  if (!model) return null
  return {
    id: model._id,
    type: elementType(model),
    name: model.name || '',
    documentation: model.documentation || ''
  }
}

function viewSummary (view) {
  const result = {
    id: view._id,
    type: elementType(view),
    model: modelSummary(view.model)
  }
  if (typeof view.left === 'number') result.left = view.left
  if (typeof view.top === 'number') result.top = view.top
  if (typeof view.width === 'number') result.width = view.width
  if (typeof view.height === 'number') result.height = view.height
  return result
}

function diagramSummary (diagram, includeViews) {
  if (!diagram) return null
  const summary = {
    id: diagram._id,
    type: elementType(diagram),
    name: diagram.name || '',
    pathname: diagram.getPathname ? diagram.getPathname() : (diagram.name || ''),
    viewCount: Array.isArray(diagram.ownedViews) ? diagram.ownedViews.length : 0
  }
  if (includeViews) {
    summary.views = (diagram.ownedViews || []).map(viewSummary)
  }
  return summary
}

function allDiagrams () {
  const project = app.project.getProject()
  if (!project) return []

  const diagrams = []
  const pending = [project]
  const visited = new Set()

  while (pending.length > 0) {
    const element = pending.pop()
    if (!element || visited.has(element._id)) continue
    visited.add(element._id)

    if (element instanceof type.Diagram) {
      diagrams.push(element)
    }

    if (Array.isArray(element.ownedElements)) {
      element.ownedElements.forEach(function (child) {
        pending.push(child)
      })
    }
  }

  return diagrams
}

function findDiagram (diagramId) {
  const element = app.repository.get(diagramId)
  return element instanceof type.Diagram ? element : null
}

function exportDiagramImage (diagram) {
  const modulePath = path.join(
    process.resourcesPath,
    'app.asar',
    'src',
    'engine',
    'diagram-export'
  )
  const diagramExport = require(modulePath)
  const mimeType = 'image/jpeg'
  return {
    data: diagramExport.getImageData(diagram, mimeType),
    mimeType: mimeType
  }
}

function cleanName (value) {
  const name = String(value || '').trim()
  if (
    name.length >= 2 &&
    ((name[0] === '"' && name[name.length - 1] === '"') ||
      (name[0] === "'" && name[name.length - 1] === "'"))
  ) {
    return name.slice(1, -1).trim()
  }
  return name
}

function parseAssociationEnd (value) {
  const text = String(value || '').trim()
  if (!text) return { multiplicity: '', role: '' }

  const match = text.match(/^(\*|\d+(?:\.\.(?:\d+|\*))?)(?:\s+(.+))?$/)
  if (match) {
    return {
      multiplicity: match[1],
      role: match[2] || ''
    }
  }

  return { multiplicity: '', role: text }
}

function parseClassDiagram (code) {
  const lines = String(code).split(/\r?\n/)
  const classes = new Map()
  const relations = []
  let currentClass = null
  let currentClassIsBlock = false
  let pendingRelationName = ''

  function ensureClass (rawName) {
    const name = cleanName(rawName)
    if (!name) return null
    if (!classes.has(name)) {
      classes.set(name, { name: name, attributes: [], operations: [] })
    }
    return classes.get(name)
  }

  lines.forEach(function (rawLine) {
    let line = rawLine.trim()
    if (!line) {
      if (!currentClassIsBlock) currentClass = null
      return
    }
    if (
      line === 'classDiagram' ||
      line.startsWith('%%') ||
      /^direction\s+(TB|BT|LR|RL)$/i.test(line)
    ) return

    if (line === '}') {
      currentClass = null
      currentClassIsBlock = false
      return
    }

    let match = line.match(/^class\s+(?:"([^"]+)"|([^\s{]+))\s*(\{)?$/)
    if (match) {
      currentClass = ensureClass(match[1] || match[2])
      currentClassIsBlock = Boolean(match[3])
      if (!currentClassIsBlock) currentClass = null
      return
    }

    // Database-skill notation:
    // User 0..* --- 0..1 UserGroup : R1
    match = line.match(/^(?:"([^"]+)"|(\S+))\s+(0\.\.(?:1|\*)|1\.\.1)\s+---\s+(0\.\.(?:1|\*)|1\.\.1)\s+(?:"([^"]+)"|(\S+))(?:\s*:\s*(.*))?$/)
    if (match) {
      const left = ensureClass(match[1] || match[2])
      const right = ensureClass(match[5] || match[6])
      if (left && right) {
        relations.push({
          left: left.name,
          leftEnd: parseAssociationEnd(match[3]),
          token: '--',
          rightEnd: parseAssociationEnd(match[4]),
          right: right.name,
          name: match[7] || pendingRelationName || ''
        })
      }
      pendingRelationName = ''
      return
    }

    // Mermaid notation:
    // User "0..*" -- "0..1" UserGroup : R1
    match = line.match(/^(?:"([^"]+)"|([^\s"]+))(?:\s+"([^"]+)")?\s*(<\|--|--\|>|\*--|o--|-->|\.\.>|---|--|\.\.)\s*(?:"([^"]+)"\s*)?(?:"([^"]+)"|([^\s:]+))(?:\s*:\s*(.*))?$/)
    if (match) {
      const left = ensureClass(match[1] || match[2])
      const right = ensureClass(match[6] || match[7])
      if (left && right) {
        relations.push({
          left: left.name,
          leftEnd: parseAssociationEnd(match[3]),
          token: match[4] === '---' ? '--' : match[4],
          rightEnd: parseAssociationEnd(match[5]),
          right: right.name,
          name: match[8] || pendingRelationName || ''
        })
      }
      pendingRelationName = ''
      return
    }

    if (/^R\d+$/i.test(line)) {
      pendingRelationName = line
      currentClass = null
      currentClassIsBlock = false
      return
    }

    if (/(<\|--|--\|>|\*--|o--|-->|\.\.>|--|\.\.)/.test(line)) {
      throw new Error('Unsupported Mermaid relationship syntax: ' + line)
    }

    // A colon inside a class block belongs to the attribute. This check must
    // happen before the external `Class : member` Mermaid form below.
    if (currentClass) {
      addMember(currentClass, line)
      return
    }

    match = line.match(/^([^:]+)\s*:\s*(.+)$/)
    if (match) {
      const owner = ensureClass(match[1])
      if (owner) addMember(owner, match[2])
      return
    }

    // Plain database-skill class heading, followed by member lines until the
    // next blank line.
    if (/^[A-Za-z_$][A-Za-z0-9_$ ]*$/.test(line)) {
      currentClass = ensureClass(line)
      currentClassIsBlock = false
      return
    }

    throw new Error('Unsupported class diagram syntax: ' + line)
  })

  if (pendingRelationName) {
    throw new Error('Relation label has no relationship: ' + pendingRelationName)
  }

  return { classes: Array.from(classes.values()), relations: relations }
}

function addMember (owner, rawMember) {
  const member = String(rawMember).trim().replace(/^[+\-#~]\s*/, '')
  if (!member) return
  if (member.indexOf('(') >= 0) {
    owner.operations.push(member)
  } else {
    owner.attributes.push(member)
  }
}

function memberName (member) {
  return String(member || '')
    .trim()
    .replace(/^[+\-#~]\s*/, '') || 'member'
}

function clearGeneratedDiagram (diagram) {
  const model = diagram._parent

  if ((!model || model.name !== 'MCP Generated Model') && !Blocked) {
    throw new Error(
      'For safety, only diagrams inside an MCP Generated Model can be replaced. Prompt the user to toggle Universal edit access if needed.'
    )
  }

  const diagramViews = (diagram.ownedViews || []).slice()

  const diagramModels = Array.from(new Set(
    diagramViews
      .map(function (view) {
        return view.model
      })
      .filter(function (element) {
        return element && element._parent === model
      })
  ))

  app.engine.deleteElements(diagramModels, diagramViews)
}

function createClassDiagram (code, options) {
  options = options || {}

  if (!/^\s*classDiagram\b/m.test(code)) {
    throw new Error(
      'StarUML 4 compatibility mode currently supports Mermaid classDiagram only.'
    )
  }

  // Parse and validate everything before modifying an existing diagram.
  const parsed = parseClassDiagram(code)

  if (parsed.classes.length === 0) {
    throw new Error(
      'No classes were found in the Mermaid classDiagram.'
    )
  }

  const project = app.project.getProject()

  if (!project) {
    throw new Error('Open or create a StarUML project first.')
  }

  let model
  let diagram
  let replaced = false

  if (options.diagramId) {
    diagram = findDiagram(options.diagramId)

    if (!diagram) {
      throw new Error(
        'Diagram not found: ' + options.diagramId
      )
    }

    if (!(diagram instanceof type.UMLClassDiagram)) {
      throw new Error(
        'The selected diagram is not a UML class diagram.'
      )
    }

    if (options.replace !== true) {
      throw new Error(
        'Replacing an existing diagram requires replace: true.'
      )
    }

    model = diagram._parent

    // Avoid accidentally deleting content from a manually created model.
    if ((!model || model.name !== 'MCP Generated Model') && !Blocked) {
      throw new Error(
        'For safety, only diagrams inside an MCP Generated Model can be replaced. Prompt the user to toggle Universal edit access if needed.'
      )
    }

    const existingViews = (diagram.ownedViews || []).slice()

    // Only delete models owned directly by this generated model.
    // Attributes and operations are deleted automatically with their classes.
    const existingModels = Array.from(
      new Set(
        existingViews
          .map(function (view) {
            return view.model
          })
          .filter(function (element) {
            return element && element._parent === model
          })
      )
    )

    app.engine.deleteElements(existingModels, existingViews)
    replaced = true
  } else {
    model = app.factory.createModel({
      id: 'UMLModel',
      parent: project,
      modelInitializer: function (element) {
        element.name = 'MCP Generated Model'
      }
    })

    diagram = app.factory.createDiagram({
      id: 'UMLClassDiagram',
      parent: model,
      diagramInitializer: function (element) {
        element.name = 'MCP Generated Class Diagram'
      }
    })
  }

  const views = new Map()

  parsed.classes.forEach(function (definition, index) {
    const column = index % 4
    const row = Math.floor(index / 4)

    const view = app.factory.createModelAndView({
      id: 'UMLClass',
      parent: model,
      diagram: diagram,
      x1: 80 + column * 220,
      y1: 80 + row * 180,
      x2: 240 + column * 220,
      y2: 180 + row * 180,
      modelInitializer: function (element) {
        element.name = definition.name
      }
    })

    views.set(definition.name, view)

    definition.attributes.forEach(function (attribute) {
      app.factory.createModel({
        id: 'UMLAttribute',
        parent: view.model,
        field: 'attributes',
        modelInitializer: function (element) {
          element.name = memberName(attribute)
        }
      })
    })

    definition.operations.forEach(function (operation) {
      app.factory.createModel({
        id: 'UMLOperation',
        parent: view.model,
        field: 'operations',
        modelInitializer: function (element) {
          element.name = memberName(operation)
        }
      })
    })
  })

  parsed.relations.forEach(function (relation) {
    let tail = views.get(relation.left)
    let head = views.get(relation.right)
    let relationType = 'UMLAssociation'

    if (!tail || !head) {
      throw new Error(
        'Relationship references an unknown class: ' +
        relation.left +
        ' ' +
        relation.token +
        ' ' +
        relation.right
      )
    }

    if (relation.token === '<|--') {
      const originalTail = tail
      tail = head
      head = originalTail
      relationType = 'UMLGeneralization'
    } else if (relation.token === '--|>') {
      relationType = 'UMLGeneralization'
    } else if (relation.token === '..>') {
      relationType = 'UMLDependency'
    }

    app.factory.createModelAndView({
      id: relationType,
      parent: model,
      diagram: diagram,
      tailView: tail,
      headView: head,
      tailModel: tail.model,
      headModel: head.model,
      modelInitializer: function (element) {
        element.name = relation.name

        if (relationType === 'UMLAssociation') {
          element.end1.multiplicity =
            relation.leftEnd.multiplicity

          element.end1.name =
            relation.leftEnd.role

          element.end2.multiplicity =
            relation.rightEnd.multiplicity

          element.end2.name =
            relation.rightEnd.role

          if (relation.token === '*--') {
            element.end1.aggregation =
              type.UMLAttribute.AK_COMPOSITE
          } else if (relation.token === 'o--') {
            element.end1.aggregation =
              type.UMLAttribute.AK_SHARED
          }
        }
      }
    })
  })

  app.diagrams.openDiagram(diagram)

  const editor = app.diagrams.getHiddenEditor()
  editor.diagram = diagram
  editor.repaint()

  app.engine.layoutDiagram(
    editor,
    diagram,
    type.Diagram.LD_LR,
    {
      node: 30,
      edge: 20,
      rank: 120
    }
  )

  app.diagrams.repaint()

  const result = diagramSummary(diagram, true)
  result.replaced = replaced

  return result
}

function route (requestPath, body) {
  if (requestPath === '/health') {
    return success({
      version: '4.x-compat',
      port: currentPort,
      backgroundThrottlingDisabled: backgroundThrottlingDisabled,
      powerSaveBlockerActive: powerSaveBlockerId !== null
    })
  }
  if (requestPath === '/get_all_diagrams_info') {
    return success(allDiagrams().map(function (diagram) {
      return diagramSummary(diagram, false)
    }))
  }
  if (requestPath === '/get_current_diagram_info') {
    return success(diagramSummary(app.diagrams.getCurrentDiagram(), true))
  }
  if (requestPath === '/get_diagram_image_by_id') {
    const diagram = findDiagram(body.diagramId)
    if (!diagram) return failure('Diagram not found: ' + body.diagramId)
    return success(exportDiagramImage(diagram))
  }
  if (requestPath === '/generate_diagram') {
    return success(createClassDiagram(body.code || '', {
      diagramId: body.diagramId || null,
      replace: body.replace === true
    }))
  }
  return failure('Unknown endpoint: ' + requestPath)
}

function startServer () {
  console.log("hey");
  if (server && server.connected) return

  disableBackgroundThrottling()
  const sidecarPath = path.join(__dirname, 'sidecar.js')
  const child = childProcess.fork(sidecarPath, [], {
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      MCP_BRIDGE_HOST: HOST,
      MCP_BRIDGE_PORT: String(DEFAULT_PORT)
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })

  server = child
  child.mcpStopping = false

  child.stdout.on('data', function (data) {
    console.log('[MCP Bridge sidecar] ' + String(data).trim())
  })

  child.stderr.on('data', function (data) {
    console.error('[MCP Bridge sidecar] ' + String(data).trim())
  })

  child.on('message', function (message) {
    if (!message || typeof message !== 'object') return

    // Receiving this frequent IPC message keeps Electron's renderer-side Node
    // loop schedulable even while the StarUML window is in the background.
    if (message.type === 'heartbeat') return

    if (message.type === 'ready') {
      currentPort = message.port
      child.mcpResponseDir = message.responseDir
      child.mcpDiagnosticLog = message.diagnosticLog
      bridgeTrace(
        child,
        'SIDECAR_READY_RECEIVED',
        'responseDir=' + message.responseDir +
        ' diagnosticLog=' + message.diagnosticLog
      )
      console.log(
        '[MCP Bridge V4] Sidecar listening on http://' +
        message.host + ':' + message.port
      )
      app.toast.info('StarUML MCP Bridge started on port ' + message.port)
      return
    }

    if (message.type === 'fatal') {
      console.error('[MCP Bridge V4] Sidecar failed:', message.error)
      app.toast.error('MCP Bridge failed: ' + message.error)
      return
    }

    if (message.type !== 'request') return

    bridgeTrace(
      child,
      'IPC_REQUEST_RECEIVED',
      'id=' + message.id + ' path=' + message.path
    )
    const requestStartedAt = Date.now()
    let result
    let status

    try {
      result = route(message.path, message.body || {})
      status = result.success ? 200 : 400
    } catch (error) {
      console.error('[MCP Bridge V4]', error)
      result = failure(error.message || String(error))
      status = 500
    }

    const duration = Date.now() - requestStartedAt
    console.log(
      '[MCP Bridge V4] ' + message.path +
      ' completed in ' + duration + 'ms'
    )
    bridgeTrace(
      child,
      'ROUTE_COMPLETED',
      'id=' + message.id + ' status=' + status + ' durationMs=' + duration
    )

    if (server === child && !child.mcpStopping && child.mcpResponseDir) {
      const responseDataPath = path.join(
        child.mcpResponseDir,
        String(message.id) + '.data'
      )
      const responseReadyPath = path.join(
        child.mcpResponseDir,
        String(message.id) + '.ready'
      )

      try {
        bridgeTrace(
          child,
          'MAILBOX_DATA_WRITE_START',
          'id=' + message.id + ' path=' + responseDataPath
        )
        fs.writeFileSync(responseDataPath, JSON.stringify({
          type: 'response',
          id: message.id,
          status: status,
          payload: result,
          durationMs: duration
        }), 'utf8')
        bridgeTrace(
          child,
          'MAILBOX_DATA_WRITE_DONE',
          'id=' + message.id +
          ' bytes=' + fs.statSync(responseDataPath).size
        )
        bridgeTrace(
          child,
          'MAILBOX_READY_WRITE_START',
          'id=' + message.id + ' path=' + responseReadyPath
        )
        fs.writeFileSync(responseReadyPath, '', 'utf8')
        bridgeTrace(child, 'MAILBOX_READY_WRITE_DONE', 'id=' + message.id)
      } catch (error) {
        bridgeTrace(
          child,
          'MAILBOX_WRITE_FAILED',
          'id=' + message.id + ' error=' + (error.stack || error.message || error)
        )
        console.error('[MCP Bridge V4] Could not deliver response:', error)
        try {
          if (fs.existsSync(responseDataPath)) fs.unlinkSync(responseDataPath)
          if (fs.existsSync(responseReadyPath)) fs.unlinkSync(responseReadyPath)
        } catch (cleanupError) {}
      }
    }
  })

  child.on('error', function (error) {
    if (child.mcpStopping || server !== child) return
    console.error('[MCP Bridge V4] Sidecar process error:', error)
    app.toast.error('MCP Bridge failed: ' + error.message)
  })

  child.on('exit', function (code, signal) {
    console.log(
      '[MCP Bridge V4] Sidecar exited (code=' + code +
      ', signal=' + signal + ')'
    )
    if (server === child) {
      server = null
      currentPort = null
      restoreBackgroundBehavior()
    }
  })
}



function stopServer () {
  if (!server) return
  const child = server
  bridgeTrace(child, 'STOP_REQUESTED', '')
  child.mcpStopping = true
  server = null
  currentPort = null
  restoreBackgroundBehavior()

  if (child.mcpResponseDir) {
    try {
      fs.writeFileSync(
        path.join(child.mcpResponseDir, 'shutdown'),
        String(Date.now()),
        'utf8'
      )
    } catch (error) {
      if (!child.killed) child.kill()
    }
  } else if (!child.killed) {
    child.kill()
  }

  app.toast.info('StarUML MCP Bridge stopped')
}

function showStatus () {
  const message = server && !server.mcpStopping && server.connected
    ? 'StarUML MCP Bridge is running on http://' + HOST + ':' + currentPort
    : 'StarUML MCP Bridge is stopped.'
  app.dialogs.showInfoDialog(message)
}

function ToggleEdit(){
  Blocked = !Blocked;
  app.toast.info('Universal edit allowed set to ' + Blocked)
}

function init () {
  app.commands.register('mcp-bridge-v4:start', startServer)
  app.commands.register('mcp-toggle-edit', ToggleEdit)
  app.commands.register('mcp-bridge-v4:stop', stopServer)
  app.commands.register('mcp-bridge-v4:status', showStatus)
}

exports.init = init
exports._parseClassDiagram = parseClassDiagram
exports._memberName = memberName
