import { remapSyntheticContextPath } from './context-file.mjs'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function mergeArguments(baseArgs, argsTextDelta) {
  const merged = isObject(baseArgs) ? { ...baseArgs } : {}

  if (typeof argsTextDelta !== 'string' || argsTextDelta.trim().length === 0) {
    return merged
  }

  try {
    const parsed = JSON.parse(argsTextDelta)
    if (isObject(parsed)) {
      return { ...merged, ...parsed }
    }
  } catch {
    // Ignore non-JSON argument deltas.
  }

  return merged
}

function candidateToolNames(nativeToolName, nativeArgs) {
  const aliases = {
    shell: ['bash', 'shell'],
    read: ['read'],
    glob: ['glob'],
    grep: ['grep'],
    edit: nativeArgs && typeof nativeArgs.content === 'string'
      ? ['write', 'edit']
      : ['edit', 'write'],
    task: ['task'],
    web_fetch: ['webfetch', 'fetch', 'web_fetch'],
    fetch: ['webfetch', 'fetch', 'web_fetch'],
    web_search: ['google_search', 'web_search', 'websearch'],
    update_todos: ['todowrite', 'update_todos'],
    read_todos: ['todowrite', 'read_todos'],
    ask_question: ['question', 'ask_question'],
    create_plan: ['task'],
    switch_mode: ['task'],
  }

  const list = aliases[nativeToolName] || [nativeToolName]
  if (!list.includes(nativeToolName)) {
    list.push(nativeToolName)
  }

  return [...new Set(list)]
}

function createToolIndex(tools) {
  const index = new Map()

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool) || !isObject(tool.function) || typeof tool.function.name !== 'string') continue
    index.set(normalizeName(tool.function.name), tool)
  }

  return index
}

function resolveTargetTool(nativeToolName, nativeArgs, tools) {
  const index = createToolIndex(tools)
  const candidates = candidateToolNames(nativeToolName, nativeArgs)

  for (const candidate of candidates) {
    const tool = index.get(normalizeName(candidate))
    if (tool) {
      return {
        name: tool.function.name,
        tool,
      }
    }
  }

  return null
}

function takeString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function takeNumber(value) {
  return Number.isFinite(value) ? value : null
}

function shortCommandDescription(command) {
  const compact = command.replace(/\s+/g, ' ').trim()
  const preview = compact.length > 80 ? `${compact.slice(0, 77)}...` : compact
  return `Run shell command: ${preview || 'command'}`
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions)) return null

  const normalized = questions
    .map((question) => {
      if (!isObject(question)) return null

      const text = takeString(question.question)
      const header = takeString(question.header)
      const options = Array.isArray(question.options)
        ? question.options
          .map((option) => {
            if (!isObject(option)) return null
            const label = takeString(option.label)
            if (!label) return null
            return {
              label,
              description: takeString(option.description) || label,
            }
          })
          .filter(Boolean)
        : []

      if (!text || !header || options.length === 0) return null

      const out = {
        question: text,
        header: header.slice(0, 30),
        options,
      }

      if (question.multiple === true) {
        out.multiple = true
      }

      return out
    })
    .filter(Boolean)

  return normalized.length > 0 ? normalized : null
}

function normalizeTodos(todos) {
  if (!Array.isArray(todos)) return null

  const normalized = todos
    .map((todo) => {
      if (!isObject(todo)) return null
      const content = takeString(todo.content)
      if (!content) return null

      return {
        content,
        status: takeString(todo.status) || 'pending',
        priority: takeString(todo.priority) || 'medium',
      }
    })
    .filter(Boolean)

  return normalized.length > 0 ? normalized : null
}

function mapArgumentsForTargetTool(targetToolName, nativeToolName, nativeArgs) {
  const target = normalizeName(targetToolName)
  const args = isObject(nativeArgs) ? nativeArgs : {}

  if (target === 'bash') {
    const command = takeString(args.command) || takeString(args.cmd)
    const mapped = {}
    if (command) mapped.command = command

    const workdir = takeString(args.workdir) || takeString(args.path)
    if (workdir) mapped.workdir = workdir

    const timeout = takeNumber(args.timeout)
    if (timeout && timeout > 0) mapped.timeout = timeout

    const description = takeString(args.description)
    if (description) mapped.description = description
    if (!mapped.description && mapped.command) {
      mapped.description = shortCommandDescription(mapped.command)
    }

    return mapped
  }

  if (target === 'read') {
    const mapped = {}
    const rawFilePath = takeString(args.filePath) || takeString(args.path)
    const filePath = rawFilePath ? remapSyntheticContextPath(rawFilePath) : null
    if (filePath) mapped.filePath = filePath

    const offset = takeNumber(args.offset)
    const limit = takeNumber(args.limit)
    if (offset && offset > 0) mapped.offset = offset
    if (limit && limit > 0) mapped.limit = limit
    return mapped
  }

  if (target === 'glob') {
    const mapped = {}
    const pattern = takeString(args.pattern) || takeString(args.globPattern)
    const path = takeString(args.path) || takeString(args.targetDirectory)

    if (pattern) mapped.pattern = pattern
    if (path) mapped.path = path
    return mapped
  }

  if (target === 'grep') {
    const mapped = {}
    const pattern = takeString(args.pattern)
    const path = takeString(args.path)
    const include = takeString(args.include) || takeString(args.glob)

    if (pattern) mapped.pattern = pattern
    if (path) mapped.path = path
    if (include) mapped.include = include
    return mapped
  }

  if (target === 'write') {
    const mapped = {}
    const filePath = takeString(args.filePath) || takeString(args.path)
    const content = takeString(args.content) || takeString(args.streamContent)

    if (filePath) mapped.filePath = filePath
    if (content) mapped.content = content
    return mapped
  }

  if (target === 'edit') {
    const mapped = {}
    const filePath = takeString(args.filePath) || takeString(args.path)
    const oldString = takeString(args.oldString)
    const newString = takeString(args.newString)

    if (filePath) mapped.filePath = filePath
    if (oldString) mapped.oldString = oldString
    if (newString) mapped.newString = newString
    if (args.replaceAll === true) mapped.replaceAll = true
    return mapped
  }

  if (target === 'task') {
    const description = takeString(args.description) || 'Run delegated task'
    const prompt = takeString(args.prompt) || description
    const subagentType = takeString(args.subagent_type) || takeString(args.subagentType) || 'general'

    const mapped = {
      description,
      prompt,
      subagent_type: subagentType,
    }

    const model = takeString(args.model)
    if (model) mapped.model = model

    return mapped
  }

  if (target === 'webfetch') {
    const mapped = {}
    const url = takeString(args.url)
    if (url) mapped.url = url
    mapped.format = takeString(args.format) || 'markdown'

    const timeout = takeNumber(args.timeout)
    if (timeout && timeout > 0) mapped.timeout = timeout
    return mapped
  }

  if (target === 'googlesearch') {
    const mapped = {}
    const query = takeString(args.query) || takeString(args.searchTerm)
    if (query) mapped.query = query

    if (Array.isArray(args.urls)) {
      mapped.urls = args.urls.filter(url => typeof url === 'string' && url.length > 0)
    }

    mapped.thinking = typeof args.thinking === 'boolean' ? args.thinking : true
    return mapped
  }

  if (target === 'todowrite') {
    const todos = normalizeTodos(args.todos)
    return todos ? { todos } : {}
  }

  if (target === 'question') {
    const questions = normalizeQuestions(args.questions)
    return questions ? { questions } : {}
  }

  if (target === 'skill') {
    const name = takeString(args.name)
    return name ? { name } : {}
  }

  if (nativeToolName === 'web_search' && target === 'google_search') {
    return {
      query: takeString(args.query) || takeString(args.searchTerm) || '',
      thinking: true,
    }
  }

  return { ...args }
}

function trimToSchema(mappedArgs, tool) {
  const schema = isObject(tool?.function?.parameters)
    ? tool.function.parameters
    : null

  if (!schema) {
    return mappedArgs
  }

  const properties = isObject(schema.properties) ? schema.properties : null
  const required = Array.isArray(schema.required) ? schema.required : []

  const result = {}

  if (properties) {
    for (const key of Object.keys(mappedArgs)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        result[key] = mappedArgs[key]
      }
    }
  } else {
    Object.assign(result, mappedArgs)
  }

  if (required.includes('description') && typeof result.description !== 'string') {
    if (typeof result.command === 'string') {
      result.description = shortCommandDescription(result.command)
    }
  }

  if (required.includes('format') && typeof result.format !== 'string') {
    result.format = 'markdown'
  }

  if (required.includes('thinking') && typeof result.thinking !== 'boolean') {
    result.thinking = true
  }

  if (required.includes('subagent_type') && typeof result.subagent_type !== 'string') {
    result.subagent_type = 'general'
  }

  if (required.includes('description') && typeof result.description !== 'string') {
    result.description = 'Run delegated task'
  }

  if (required.includes('prompt') && typeof result.prompt !== 'string') {
    result.prompt = typeof result.description === 'string' ? result.description : 'Complete the delegated task'
  }

  for (const key of required) {
    const value = result[key]
    if (value === undefined || value === null) return null
    if (typeof value === 'string' && value.length === 0) return null
    if (Array.isArray(value) && value.length === 0) return null
  }

  return result
}

export function bridgeNativeToolCallToXml(event, tools, argsTextDelta = '') {
  if (!isObject(event) || typeof event.toolName !== 'string' || event.toolName.length === 0) {
    return null
  }

  const nativeArgs = mergeArguments(event.toolArguments, argsTextDelta)
  const resolved = resolveTargetTool(event.toolName, nativeArgs, tools)
  if (!resolved) {
    return null
  }

  const mappedArgs = mapArgumentsForTargetTool(resolved.name, event.toolName, nativeArgs)
  const schemaArgs = trimToSchema(mappedArgs, resolved.tool)
  if (!schemaArgs || !isObject(schemaArgs)) {
    return null
  }

  const payload = {
    name: resolved.name,
    arguments: schemaArgs,
  }

  if (typeof event.callId === 'string' && event.callId.length > 0) {
    payload.id = event.callId
  }

  return `<tool_call>${JSON.stringify(payload)}</tool_call>`
}
