import fs from 'fs'
import path from 'path'
import { Plugin } from '../plugin'
import chalk from 'chalk'
import {
  FS_PREFIX,
  JS_TYPES_RE,
  SPECIAL_QUERY_RE,
  SUPPORTED_EXTS
} from '../constants'
import {
  isBuiltin,
  bareImportRE,
  createDebugger,
  deepImportRE,
  injectQuery,
  isExternalUrl,
  isObject,
  normalizePath,
  fsPathFromId,
  ensureVolumeInPath,
  resolveFrom,
  isDataUrl,
  cleanUrl,
  slash
} from '../utils'
import { ViteDevServer } from '..'
import { createFilter } from '@rollup/pluginutils'
import { PartialResolvedId } from 'rollup'
import { resolve as _resolveExports } from 'resolve.exports'

const MAIN_FIELDS = [
  'module',
  'jsnext:main', // moment still uses this...
  'jsnext'
]

function resolveExports(
  pkg: PackageData['data'],
  key: string,
  isProduction: boolean
) {
  return _resolveExports(pkg, key, {
    browser: true,
    conditions: ['module', isProduction ? 'production' : 'development']
  })
}

// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
export const browserExternalId = '__vite-browser-external'

const isDebug = process.env.DEBUG
const debug = createDebugger('vite:resolve-details', {
  onlyWhenFocused: true
})

export interface ResolveOptions {
  root: string
  isBuild: boolean
  isProduction: boolean
  /**
   * src code mode also attempts the following:
   * - resolving /xxx as URLs
   * - resolving bare imports from optimized deps
   */
  asSrc?: boolean
  tryIndex?: boolean
  tryPrefix?: string
  relativeFirst?: boolean
  mainFields?: string[]
  extensions?: string[]
  dedupe?: string[]
}

export function resolvePlugin(options: ResolveOptions): Plugin {
  const { root, isProduction, asSrc, relativeFirst = false } = options
  let server: ViteDevServer | undefined

  return {
    name: 'vite:resolve',

    configureServer(_server) {
      server = _server
    },

    resolveId(id, importer, _, ssr) {
      if (id.startsWith(browserExternalId)) {
        return id
      }

      // fast path for commonjs proxy modules
      if (/\?commonjs/.test(id) || id === 'commonjsHelpers.js') {
        return
      }

      let res

      // explicit fs paths that starts with /@fs/*
      if (asSrc && id.startsWith(FS_PREFIX)) {
        const fsPath = fsPathFromId(id)
        res = tryFsResolve(fsPath, options)
        isDebug && debug(`[@fs] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
        // always return here even if res doesn't exist since /@fs/ is explicit
        // if the file doesn't exist it should be a 404
        return res || fsPath
      }

      // URL
      // /foo -> /fs-root/foo
      if (asSrc && id.startsWith('/')) {
        const fsPath = path.resolve(root, id.slice(1))
        if ((res = tryFsResolve(fsPath, options))) {
          isDebug && debug(`[url] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
          return res
        }
      }

      // relative
      if (id.startsWith('.') || (relativeFirst && /^\w/.test(id))) {
        const basedir = importer ? path.dirname(importer) : process.cwd()
        let fsPath = path.resolve(basedir, id)
        // handle browser field mapping for relative imports

        if ((res = tryResolveBrowserMapping(fsPath, importer, options, true))) {
          return res
        }

        if ((res = tryFsResolve(fsPath, options))) {
          isDebug && debug(`[relative] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
          const pkg = importer != null && idToPkgMap.get(importer)
          if (pkg) {
            idToPkgMap.set(res, pkg)
            return {
              id: res,
              moduleSideEffects: pkg.hasSideEffects(res)
            }
          }
          return res
        }
      }

      // absolute fs paths
      if (path.isAbsolute(id) && (res = tryFsResolve(id, options))) {
        isDebug && debug(`[fs] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
        return res
      }

      // external
      if (isExternalUrl(id)) {
        return {
          id,
          external: true
        }
      }

      // data uri: pass through (this only happens during build and will be
      // handled by dedicated plugin)
      if (isDataUrl(id)) {
        return null
      }

      // bare package imports, perform node resolve
      if (bareImportRE.test(id)) {
        if (
          asSrc &&
          server &&
          !ssr &&
          (res = tryOptimizedResolve(id, server))
        ) {
          return res
        }

        if ((res = tryResolveBrowserMapping(id, importer, options, false))) {
          return res
        }

        if ((res = tryNodeResolve(id, importer, options, server))) {
          return res
        }

        // node built-ins.
        // externalize if building for SSR, otherwise redirect to empty module
        if (isBuiltin(id)) {
          if (ssr) {
            return {
              id,
              external: true
            }
          } else {
            if (!asSrc) {
              debug(
                `externalized node built-in "${id}" to empty module. ` +
                  `(imported by: ${chalk.white.dim(importer)})`
              )
            }
            return isProduction
              ? browserExternalId
              : `${browserExternalId}:${id}`
          }
        }
      }

      isDebug && debug(`[fallthrough] ${chalk.dim(id)}`)
    },

    load(id) {
      if (id.startsWith(browserExternalId)) {
        return isProduction
          ? `export default {}`
          : `export default new Proxy({}, {
  get() {
    throw new Error('Module "${id.slice(
      browserExternalId.length + 1
    )}" has been externalized for browser compatibility and cannot be accessed in client code.')
  }
})`
      }
    }
  }
}

function tryFsResolve(
  fsPath: string,
  options: ResolveOptions,
  tryIndex = true
): string | undefined {
  const [file, q] = fsPath.split(`?`, 2)
  const query = q ? `?${q}` : ``
  let res: string | undefined
  for (const ext of options.extensions || SUPPORTED_EXTS) {
    if (
      (res = tryResolveFile(
        file + ext,
        query,
        options,
        false,
        options.tryPrefix
      ))
    ) {
      return res
    }
  }
  if (
    (res = tryResolveFile(file, query, options, tryIndex, options.tryPrefix))
  ) {
    return res
  }
}

function tryResolveFile(
  file: string,
  query: string,
  options: ResolveOptions,
  tryIndex: boolean,
  tryPrefix?: string
): string | undefined {
  if (fs.existsSync(file)) {
    const isDir = fs.statSync(file).isDirectory()
    if (isDir && tryIndex) {
      const pkgPath = file + '/package.json'
      if (fs.existsSync(pkgPath)) {
        // path points to a node package
        const pkg = loadPackageData(pkgPath)
        return resolvePackageEntry(file, pkg, options)
      }
      const index = tryFsResolve(file + '/index', options)
      if (index) return index + query
    } else {
      return normalizePath(ensureVolumeInPath(file)) + query
    }
  }
  if (tryPrefix) {
    const prefixed = `${path.dirname(file)}/${tryPrefix}${path.basename(file)}`
    return tryResolveFile(prefixed, query, options, tryIndex)
  }
}

export const idToPkgMap = new Map<string, PackageData>()

export function tryNodeResolve(
  id: string,
  importer: string | undefined,
  options: ResolveOptions,
  server?: ViteDevServer
): PartialResolvedId | undefined {
  const { root, dedupe, isBuild } = options
  const deepMatch = id.match(deepImportRE)
  const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : id

  let basedir
  if (dedupe && dedupe.includes(pkgId)) {
    basedir = root
  } else if (
    importer &&
    path.isAbsolute(importer) &&
    fs.existsSync(cleanUrl(importer))
  ) {
    basedir = path.dirname(importer)
  } else {
    basedir = root
  }

  const pkg = resolvePackageData(pkgId, basedir)

  if (!pkg) {
    return
  }

  let resolved = deepMatch
    ? resolveDeepImport(id, pkg, options)
    : resolvePackageEntry(id, pkg, options)
  if (!resolved) {
    return
  }
  // link id to pkg for browser field mapping check
  idToPkgMap.set(resolved, pkg)
  if (isBuild) {
    // Resolve package side effects for build so that rollup can better
    // perform tree-shaking
    return {
      id: resolved,
      moduleSideEffects: pkg.hasSideEffects(resolved)
    }
  } else {
    if (
      !resolved.includes('node_modules') || // linked
      !server || // build
      server._isRunningOptimizer || // optimizing
      !server._optimizeDepsMetadata
    ) {
      return { id: resolved }
    }
    // if we reach here, it's a valid dep import that hasn't been optimzied.
    const isJsType = JS_TYPES_RE.test(resolved)
    const exclude = server.config.optimizeDeps?.exclude
    if (
      !isJsType ||
      importer?.includes('node_modules') ||
      exclude?.includes(pkgId) ||
      exclude?.includes(id) ||
      SPECIAL_QUERY_RE.test(resolved)
    ) {
      // excluded from optimization
      // Inject a version query to npm deps so that the browser
      // can cache it without revalidation, but only do so for known js types.
      // otherwise we may introduce duplicated modules for externalized files
      // from pre-bundled deps.
      const versionHash = server._optimizeDepsMetadata?.browserHash
      if (versionHash && isJsType) {
        resolved = injectQuery(resolved, `v=${versionHash}`)
      }
    } else {
      // this is a missing import.
      // queue optimize-deps re-run.
      server._registerMissingImport?.(id, resolved)
    }
    return { id: resolved }
  }
}

export function tryOptimizedResolve(
  id: string,
  server: ViteDevServer
): string | undefined {
  const cacheDir = server.config.optimizeCacheDir
  const depData = server._optimizeDepsMetadata
  if (cacheDir && depData) {
    const isOptimized = depData.optimized[id]
    if (isOptimized) {
      return (
        isOptimized.file +
        `?v=${depData.browserHash}${
          isOptimized.needsInterop ? `&es-interop` : ``
        }`
      )
    }
  }
}

export interface PackageData {
  dir: string
  hasSideEffects: (id: string) => boolean
  resolvedImports: Record<string, string | undefined>
  data: {
    [field: string]: any
    version: string
    main: string
    module: string
    browser: string | Record<string, string | false>
    exports: string | Record<string, any> | string[]
    dependencies: Record<string, string>
  }
}

const packageCache = new Map<string, PackageData>()

export function resolvePackageData(
  id: string,
  basedir: string
): PackageData | undefined {
  const cacheKey = id + basedir
  if (packageCache.has(cacheKey)) {
    return packageCache.get(cacheKey)
  }
  try {
    const pkgPath = resolveFrom(`${id}/package.json`, basedir)
    return loadPackageData(pkgPath, cacheKey)
  } catch (e) {
    isDebug && debug(`${chalk.red(`[failed loading package.json]`)} ${id}`)
  }
}

function loadPackageData(pkgPath: string, cacheKey = pkgPath) {
  const data = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const pkgDir = path.dirname(pkgPath)
  const { sideEffects } = data
  let hasSideEffects
  if (typeof sideEffects === 'boolean') {
    hasSideEffects = () => sideEffects
  } else if (Array.isArray(sideEffects)) {
    hasSideEffects = createFilter(sideEffects, null, { resolve: pkgDir })
  } else {
    hasSideEffects = () => true
  }

  const pkg = {
    dir: pkgDir,
    data,
    hasSideEffects,
    resolvedImports: {}
  }
  packageCache.set(cacheKey, pkg)
  return pkg
}

export function resolvePackageEntry(
  id: string,
  { resolvedImports, dir, data }: PackageData,
  options: ResolveOptions
): string | undefined {
  if (resolvedImports['.']) {
    return resolvedImports['.']
  }

  let entryPoint: string | undefined | void

  // resolve exports field with highest priority
  // using https://github.com/lukeed/resolve.exports
  if (data.exports) {
    entryPoint = resolveExports(data, '.', options.isProduction)
  }

  // if exports resolved to .mjs, still resolve other fields.
  // This is because .mjs files can technically import .cjs files which would
  // make them invalid for pure ESM environments - so if other module/browser
  // fields are present, prioritize those instead.
  if (!entryPoint || entryPoint.endsWith('.mjs')) {
    // check browser field
    // https://github.com/defunctzombie/package-browser-field-spec
    const browserEntry =
      typeof data.browser === 'string'
        ? data.browser
        : isObject(data.browser) && data.browser['.']
    if (browserEntry) {
      // check if the package also has a "module" field.
      if (typeof data.module === 'string' && data.module !== browserEntry) {
        // if both are present, we may have a problem: some package points both
        // to ESM, with "module" targeting Node.js, while some packages points
        // "module" to browser ESM and "browser" to UMD.
        // the heuristics here is to actually read the browser entry when
        // possible and check for hints of UMD. If it is UMD, prefer "module"
        // instead; Otherwise, assume it's ESM and use it.
        const resolvedBrowserEntry = tryFsResolve(
          path.join(dir, browserEntry),
          options
        )
        if (resolvedBrowserEntry) {
          const content = fs.readFileSync(resolvedBrowserEntry, 'utf-8')
          if (
            (/typeof exports\s*==/.test(content) &&
              /typeof module\s*==/.test(content)) ||
            /module\.exports\s*=/.test(content)
          ) {
            // likely UMD or CJS(!!! e.g. firebase 7.x), prefer module
            entryPoint = data.module
          }
        }
      } else {
        entryPoint = browserEntry
      }
    }
  }

  if (!entryPoint || entryPoint.endsWith('.mjs')) {
    for (const field of options.mainFields || MAIN_FIELDS) {
      if (typeof data[field] === 'string') {
        entryPoint = data[field]
        break
      }
    }
  }

  entryPoint = entryPoint || data.main || 'index.js'

  // resolve object browser field in package.json
  const { browser: browserField } = data
  if (isObject(browserField)) {
    entryPoint = mapWithBrowserField(entryPoint, browserField) || entryPoint
  }

  entryPoint = path.join(dir, entryPoint)
  const resolvedEntryPont = tryFsResolve(entryPoint, options)

  if (resolvedEntryPont) {
    isDebug &&
      debug(
        `[package entry] ${chalk.cyan(id)} -> ${chalk.dim(resolvedEntryPont)}`
      )
    resolvedImports['.'] = resolvedEntryPont
    return resolvedEntryPont
  } else {
    throw new Error(
      `Failed to resolve entry for package "${id}". ` +
        `The package may have incorrect main/module/exports specified in its package.json.`
    )
  }
}

function resolveDeepImport(
  id: string,
  { resolvedImports, dir, data }: PackageData,
  options: ResolveOptions
): string | undefined {
  id = '.' + id.slice(data.name.length)
  if (resolvedImports[id]) {
    return resolvedImports[id]
  }

  let relativeId: string | undefined | void = id
  const { exports: exportsField, browser: browserField } = data

  // map relative based on exports data
  if (exportsField) {
    if (isObject(exportsField) && !Array.isArray(exportsField)) {
      relativeId = resolveExports(data, relativeId, options.isProduction)
    } else {
      // not exposed
      relativeId = undefined
    }
    if (!relativeId) {
      throw new Error(
        `Package subpath '${relativeId}' is not defined by "exports" in ` +
          `${path.join(dir, 'package.json')}.`
      )
    }
  } else if (isObject(browserField)) {
    const mapped = mapWithBrowserField(relativeId, browserField)
    if (mapped) {
      relativeId = mapped
    } else {
      return (resolvedImports[id] = browserExternalId)
    }
  }

  if (relativeId) {
    const resolved = tryFsResolve(
      path.join(dir, relativeId),
      options,
      !exportsField // try index only if no exports field
    )
    if (resolved) {
      isDebug &&
        debug(`[node/deep-import] ${chalk.cyan(id)} -> ${chalk.dim(resolved)}`)
      return (resolvedImports[id] = resolved)
    }
  }
}

function tryResolveBrowserMapping(
  id: string,
  importer: string | undefined,
  options: ResolveOptions,
  isFilePath: boolean
) {
  let res: string | undefined
  const pkg = importer && idToPkgMap.get(importer)
  if (pkg && isObject(pkg.data.browser)) {
    const mapId = isFilePath ? './' + slash(path.relative(pkg.dir, id)) : id
    const browserMappedPath = mapWithBrowserField(mapId, pkg.data.browser)
    if (browserMappedPath) {
      const fsPath = path.join(pkg.dir, browserMappedPath)
      if ((res = tryFsResolve(fsPath, options))) {
        isDebug &&
          debug(`[browser mapped] ${chalk.cyan(id)} -> ${chalk.dim(res)}`)
        idToPkgMap.set(res, pkg)
        return {
          id: res,
          moduleSideEffects: pkg.hasSideEffects(res)
        }
      }
    } else {
      return browserExternalId
    }
  }
}

/**
 * given a relative path in pkg dir,
 * return a relative path in pkg dir,
 * mapped with the "map" object
 */
function mapWithBrowserField(
  relativePathInPkgDir: string,
  map: Record<string, string | false>
) {
  const normalized = normalize(relativePathInPkgDir)
  const foundEntry = Object.entries(map).find(
    ([from]) => normalize(from) === normalized
  )
  if (!foundEntry) {
    return relativePathInPkgDir
  }
  return foundEntry[1]
}

function normalize(file: string) {
  return path.posix.normalize(path.extname(file) ? file : file + '.js')
}
