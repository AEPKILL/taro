import * as fs from 'fs-extra'
import * as path from 'path'

import * as chokidar from 'chokidar'
import chalk from 'chalk'
import wxTransformer from '@tarojs/transformer-wx'
import * as t from 'babel-types'
import generate from 'babel-generator'
import traverse from 'babel-traverse'
import * as _ from 'lodash'
import { IProjectConfig, IH5Config } from '@tarojs/taro/types/compile'

import { Compiler } from './h5'
import * as npmProcess from './util/npm'

import CONFIG from './config'
import {
  resolveScriptPath,
  resolveStylePath,
  printLog,
  cssImports
} from './util'
import {
  processTypeEnum,
  PROJECT_CONFIG,
  BUILD_TYPES,
  REG_STYLE,
  REG_TYPESCRIPT,
  REG_SCRIPT,
  REG_JSON,
  REG_FONT,
  REG_IMAGE,
  REG_MEDIA
} from './util/constants'
import { IBuildOptions } from './util/types'
import { setBuildData as setMiniBuildData } from './mini/helper'

interface IBuildData {
  appPath: string,
  projectConfig: IProjectConfig,
  sourceDirName: string,
  outputDirName: string,
  sourceDir: string,
  entryFilePath: string,
  entryFileName: string,
  tempPath: string
}

interface IComponentObj {
  name?: string,
  path: string | null,
  type?: string
}

interface IParseAstReturn {
  styleFiles: string[],
  scriptFiles: string[],
  jsonFiles: string[],
  mediaFiles: string[]
}

const weappOutputName = 'weapp'
const h5OutputName = 'h5'
const tempDir = '.temp'

let buildData: IBuildData

const processedScriptFiles:Set<string> = new Set()

function parseAst (
  ast: t.File,
  sourceFilePath: string
): IParseAstReturn {
  const styleFiles: string[] = []
  const scriptFiles: string[] = []
  const jsonFiles: string[] = []
  const mediaFiles: string[] = []

  traverse(ast, {
    Program: {
      exit (astPath) {
        astPath.traverse({
          ImportDeclaration (astPath) {
            const node = astPath.node
            const source = node.source
            const value = source.value
            const valueExtname = path.extname(value)
            if (value.indexOf('.') === 0) {
              let importPath = path.resolve(path.dirname(sourceFilePath), value)
              importPath = resolveScriptPath(importPath)
              if (REG_SCRIPT.test(valueExtname) || REG_TYPESCRIPT.test(valueExtname)) {
                const vpath = path.resolve(sourceFilePath, '..', value)
                let fPath = value
                if (fs.existsSync(vpath) && vpath !== sourceFilePath) {
                  fPath = vpath
                }
                if (scriptFiles.indexOf(fPath) < 0) {
                  scriptFiles.push(fPath)
                }
              } else if (REG_JSON.test(valueExtname)) {
                const vpath = path.resolve(sourceFilePath, '..', value)
                if (fs.existsSync(vpath) && jsonFiles.indexOf(vpath) < 0) {
                  jsonFiles.push(vpath)
                }
              } else if (REG_FONT.test(valueExtname) || REG_IMAGE.test(valueExtname) || REG_MEDIA.test(valueExtname)) {
                const vpath = path.resolve(sourceFilePath, '..', value)
                if (fs.existsSync(vpath) && mediaFiles.indexOf(vpath) < 0) {
                  mediaFiles.push(vpath)
                }
              } else if (REG_STYLE.test(valueExtname)) {
                const vpath = path.resolve(path.dirname(sourceFilePath), value)
                if (fs.existsSync(vpath) && styleFiles.indexOf(vpath) < 0) {
                  styleFiles.push(vpath)
                }
              } else {
                const vpath = resolveScriptPath(path.resolve(sourceFilePath, '..', value))
                if (fs.existsSync(vpath) && scriptFiles.indexOf(vpath) < 0) {
                  scriptFiles.push(vpath)
                }
              }
            }
          }
        })
      }
    }
  })

  return {
    styleFiles,
    scriptFiles,
    jsonFiles,
    mediaFiles
  }
}

function setBuildData (appPath, uiIndex) {
  const configDir = path.join(appPath, PROJECT_CONFIG)
  const projectConfig = require(configDir)(_.merge)
  const sourceDirName = projectConfig.sourceRoot || CONFIG.SOURCE_DIR
  const outputDirName = projectConfig.outputRoot || CONFIG.OUTPUT_DIR
  const sourceDir = path.join(appPath, sourceDirName)
  let entryFilePath
  if (uiIndex) {
    entryFilePath = resolveScriptPath(path.join(sourceDir, uiIndex))
  } else {
    entryFilePath = resolveScriptPath(path.join(sourceDir, 'index'))
  }
  const entryFileName = path.basename(entryFilePath)
  const tempPath = path.join(appPath, tempDir)

  buildData = {
    appPath,
    projectConfig,
    sourceDirName,
    outputDirName,
    sourceDir,
    entryFilePath,
    entryFileName,
    tempPath
  }
}

interface IH5BuildConfig extends IH5Config {
  env?: object,
  defineConstants?: object,
  plugins?: object,
  designWidth?: number,
  deviceRatio?: object,
  sourceRoot?: string,
  outputRoot?: string,
  isWatch?: boolean
}

async function buildH5Script () {
  const { appPath, projectConfig, entryFileName, sourceDirName, tempPath } = buildData
  let { outputDirName } = buildData
  const h5Config: IH5BuildConfig = Object.assign({}, projectConfig.h5)
  const entryFile = path.basename(entryFileName, path.extname(entryFileName)) + '.js'
  outputDirName = `${outputDirName}/${h5OutputName}`
  h5Config.env = projectConfig.env
  h5Config.defineConstants = projectConfig.defineConstants
  h5Config.plugins = projectConfig.plugins
  h5Config.designWidth = projectConfig.designWidth
  if (projectConfig.deviceRatio) {
    h5Config.deviceRatio = projectConfig.deviceRatio
  }
  h5Config.sourceRoot = sourceDirName
  h5Config.outputRoot = outputDirName
  h5Config.entry = Object.assign({
    app: [path.join(tempPath, entryFile)]
  }, h5Config.entry)
  h5Config.isWatch = false
  const webpackRunner = await npmProcess.getNpmPkg('@tarojs/webpack-runner', appPath)
  webpackRunner(appPath, h5Config)
}

async function buildH5Lib (uiIndex) {
  try {
    const { appPath, outputDirName, tempPath } = buildData
    const outputDir = path.join(appPath, outputDirName, h5OutputName)
    const tempEntryFilePath = resolveScriptPath(path.join(tempPath, uiIndex))
    const outputEntryFilePath = path.join(outputDir, path.basename(tempEntryFilePath))
    const code = fs.readFileSync(tempEntryFilePath).toString()
    const transformResult = wxTransformer({
      code,
      sourcePath: tempEntryFilePath,
      isNormal: true,
      isTyped: REG_TYPESCRIPT.test(tempEntryFilePath)
    })
    const { styleFiles, components, code: generateCode } = parseEntryAst(transformResult.ast, tempEntryFilePath)
    const relativePath = path.relative(appPath, tempEntryFilePath)
    printLog(processTypeEnum.COPY, '发现文件', relativePath)
    fs.ensureDirSync(path.dirname(outputEntryFilePath))
    fs.writeFileSync(outputEntryFilePath, generateCode)
    if (components.length) {
      components.forEach(item => {
        copyFileToDist(item.path as string, tempPath, outputDir)
      })
      analyzeFiles(components.map(item => item.path as string), tempPath, outputDir)
    }
    if (styleFiles.length) {
      styleFiles.forEach(item => {
        copyFileToDist(item, tempPath, path.join(appPath, outputDirName))
      })
      analyzeStyleFilesImport(styleFiles, tempPath, path.join(appPath, outputDirName))
    }
  } catch (err) {
    console.log(err)
  }
}

function copyFileToDist (filePath: string, sourceDir: string, outputDir: string) {
  if (!filePath && !path.isAbsolute(filePath)) {
    return
  }
  const { appPath } = buildData
  const dirname = path.dirname(filePath)
  const distDirname = dirname.replace(sourceDir, outputDir)
  const relativePath = path.relative(appPath, filePath)
  printLog(processTypeEnum.COPY, '发现文件', relativePath)
  fs.ensureDirSync(distDirname)
  fs.copyFileSync(filePath, path.format({
    dir: distDirname,
    base: path.basename(filePath)
  }))
}

function parseEntryAst (ast: t.File, relativeFile: string) {
  const styleFiles: string[] = []
  const components: IComponentObj[] = []
  const importExportName: string[] = []
  let exportDefaultName: string | null = null

  traverse(ast, {
    ExportNamedDeclaration (astPath) {
      const node = astPath.node
      const specifiers = node.specifiers
      const source = node.source
      if (source && source.type === 'StringLiteral') {
        specifiers.forEach(specifier => {
          const exported = specifier.exported
          components.push({
            name: exported.name,
            path: resolveScriptPath(path.resolve(path.dirname(relativeFile), source.value))
          })
        })
      } else {
        specifiers.forEach(specifier => {
          const exported = specifier.exported
          importExportName.push(exported.name)
        })
      }
    },

    ExportDefaultDeclaration (astPath) {
      const node = astPath.node
      const declaration = node.declaration
      if (t.isIdentifier(declaration)) {
        exportDefaultName = declaration.name
      }
    },

    Program: {
      exit (astPath) {
        astPath.traverse({
          ImportDeclaration (astPath) {
            const node = astPath.node
            const specifiers = node.specifiers
            const source = node.source
            const value = source.value
            const valueExtname = path.extname(value)
            if (REG_STYLE.test(valueExtname)) {
              const stylePath = path.resolve(path.dirname(relativeFile), value)
              if (styleFiles.indexOf(stylePath) < 0) {
                styleFiles.push(stylePath)
              }
              astPath.remove()
            } else {
              if (importExportName.length) {
                importExportName.forEach(nameItem => {
                  specifiers.forEach(specifier => {
                    const local = specifier.local
                    if (local.name === nameItem) {
                      components.push({
                        name: local.name,
                        path: resolveScriptPath(path.resolve(path.dirname(relativeFile), source.value))
                      })
                    }
                  })
                })
              }
              if (exportDefaultName != null) {
                specifiers.forEach(specifier => {
                  const local = specifier.local
                  if (local.name === exportDefaultName) {
                    components.push({
                      name: local.name,
                      path: resolveScriptPath(path.resolve(path.dirname(relativeFile), source.value))
                    })
                  }
                })
              }
            }
          }
        })
      }
    }
  })
  const code = generate(ast).code
  return {
    code,
    styleFiles,
    components
  }
}

function analyzeFiles (files: string[], sourceDir: string, outputDir: string) {
  files.forEach(file => {
    if (fs.existsSync(file)) {
      if (processedScriptFiles.has(file)) {
        return
      }
      processedScriptFiles.add(file)
      const code = fs.readFileSync(file).toString()
      const transformResult = wxTransformer({
        code,
        sourcePath: file,
        outputPath: file,
        isNormal: true,
        isTyped: REG_TYPESCRIPT.test(file)
      })
      const {
        styleFiles,
        scriptFiles,
        jsonFiles,
        mediaFiles
      } = parseAst(transformResult.ast, file)
      const resFiles = styleFiles.concat(scriptFiles, jsonFiles, mediaFiles)
      if (resFiles.length) {
        resFiles.forEach(item => {
          copyFileToDist(item, sourceDir, outputDir)
        })
      }
      if (scriptFiles.length) {
        analyzeFiles(scriptFiles, sourceDir, outputDir)
      }
      if (styleFiles.length) {
        analyzeStyleFilesImport(styleFiles, sourceDir, outputDir)
      }
    }
  })
}

function analyzeStyleFilesImport (styleFiles, sourceDir, outputDir) {
  styleFiles.forEach(item => {
    if (!fs.existsSync(item)) {
      return
    }
    let content = fs.readFileSync(item).toString()
    content = content.replace(/(?:@import\s+)?\burl\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^)}\s]+)\s*\)(\s*;?)/g, (m, $1) => {
      if ($1) {
        let filePath = $1.replace(/'?"?/g, '')
        if (filePath.indexOf('.') === 0) {
          filePath = path.resolve(path.dirname(item), filePath)
          copyFileToDist(filePath, sourceDir, outputDir)
        }
      }
      return m
    })
    let imports = cssImports(content)
    if (imports.length > 0) {
      imports = imports.map(importItem => {
        const filePath = resolveStylePath(path.resolve(path.dirname(item), importItem))
        copyFileToDist(filePath, sourceDir, outputDir)
        return filePath
      })
      analyzeStyleFilesImport(imports, sourceDir, outputDir)
    }
  })
}

async function buildForWeapp () {
  const { appPath, entryFilePath, outputDirName, entryFileName, sourceDir } = buildData
  console.log()
  console.log(chalk.green('开始编译小程序端组件库！'))
  if (!fs.existsSync(entryFilePath)) {
    console.log(chalk.red('入口文件不存在，请检查！'))
    return
  }
  try {
    const outputDir = path.join(appPath, outputDirName, weappOutputName)
    const outputEntryFilePath = path.join(outputDir, entryFileName)
    const code = fs.readFileSync(entryFilePath).toString()
    const transformResult = wxTransformer({
      code,
      sourcePath: entryFilePath,
      outputPath: outputEntryFilePath,
      isNormal: true,
      isTyped: REG_TYPESCRIPT.test(entryFilePath)
    })
    const { components } = parseEntryAst(transformResult.ast, entryFilePath)
    const relativePath = path.relative(appPath, entryFilePath)
    printLog(processTypeEnum.COPY, '发现文件', relativePath)
    fs.ensureDirSync(path.dirname(outputEntryFilePath))
    fs.copyFileSync(entryFilePath, path.format({
      dir: path.dirname(outputEntryFilePath),
      base: path.basename(outputEntryFilePath)
    }))
    if (components.length) {
      components.forEach(item => {
        copyFileToDist(item.path as string, sourceDir, outputDir)
      })
      analyzeFiles(components.map(item => item.path as string), sourceDir, outputDir)
    }
  } catch (err) {
    console.log(err)
  }
}

async function buildForH5 (uiIndex = 'index') {
  const { appPath } = buildData
  const compiler = new Compiler(appPath, uiIndex)
  console.log()
  console.log(chalk.green('开始编译 H5 端组件库！'))
  await compiler.buildTemp()
  if (process.env.TARO_BUILD_TYPE === 'script') {
    await buildH5Script()
  } else {
    await buildH5Lib(uiIndex)
  }
}

function buildEntry (uiIndex) {
  const { appPath, outputDirName } = buildData
  let indexName = 'index'
  if (uiIndex) {
    indexName = path.basename(uiIndex, path.extname(uiIndex))
  }
  const content = `if (process.env.TARO_ENV === '${BUILD_TYPES.H5}') {
    module.exports = require('./${h5OutputName}/${indexName}')
    module.exports.default = module.exports
  } else {
    module.exports = require('./${weappOutputName}/${indexName}')
    module.exports.default = module.exports
  }`
  const outputDir = path.join(appPath, outputDirName)
  fs.writeFileSync(path.join(outputDir, `index.js`), content)
}

function watchFiles () {
  const { sourceDir, projectConfig, appPath, outputDirName, tempPath } = buildData
  console.log('\n', chalk.gray('监听文件修改中...'), '\n')

  const watchList = [sourceDir]

  const uiConfig = projectConfig.ui
  let extraWatchFiles
  if (uiConfig) {
    extraWatchFiles = uiConfig.extraWatchFiles
    extraWatchFiles.forEach(item => {
      watchList.push(path.join(appPath, item.path))
      if (typeof item.handler === 'function') item.callback = item.handler({ buildH5Script })
    })
  }

  const watcher = chokidar.watch(watchList, {
    ignored: /(^|[/\\])\../,
    ignoreInitial: true
  })

  function syncWeappFile (filePath) {
    const outputDir = path.join(appPath, outputDirName, weappOutputName)
    copyFileToDist(filePath, sourceDir, outputDir)
    // 依赖分析
    const extname = path.extname(filePath)
    if (REG_STYLE.test(extname)) {
      analyzeStyleFilesImport([filePath], sourceDir, outputDir)
    } else {
      analyzeFiles([filePath], sourceDir, outputDir)
    }
  }

  function syncH5File (filePath, compiler) {
    const { sourceDir, appPath, outputDirName, tempPath } = buildData
    const outputDir = path.join(appPath, outputDirName, h5OutputName)
    const fileTempPath = filePath.replace(sourceDir, tempPath)
    compiler.processFiles(filePath)

    if (process.env.TARO_BUILD_TYPE === 'script') {
      buildH5Script()
    } else {
      copyFileToDist(fileTempPath, tempPath, outputDir)
      // 依赖分析
      const extname = path.extname(filePath)
      if (REG_STYLE.test(extname)) {
        analyzeStyleFilesImport([fileTempPath], tempPath, outputDir)
      } else {
        analyzeFiles([fileTempPath], tempPath, outputDir)
      }
    }
  }

  function handleChange (filePath, type, tips) {
    const relativePath = path.relative(appPath, filePath)
    const compiler = new Compiler(appPath)
    printLog(type, tips, relativePath)

    let processed = false
    extraWatchFiles && extraWatchFiles.forEach(item => {
      if (filePath.indexOf(item.path.substr(2)) < 0) return
      if (typeof item.callback === 'function') {
        item.callback()
        processed = true
      }
    })
    if (processed) return

    try {
      syncWeappFile(filePath)
      syncH5File(filePath, compiler)
    } catch (err) {
      console.log(err)
    }
  }

  watcher
    .on('add', filePath => handleChange(filePath, processTypeEnum.CREATE, '添加文件'))
    .on('change', filePath => handleChange(filePath, processTypeEnum.MODIFY, '文件变动'))
    .on('unlink', filePath => {
      for (const path in extraWatchFiles) {
        if (filePath.indexOf(path.substr(2)) > -1) return
      }

      const relativePath = path.relative(appPath, filePath)
      printLog(processTypeEnum.UNLINK, '删除文件', relativePath)
      const weappOutputPath = path.join(appPath, outputDirName, weappOutputName)
      const h5OutputPath = path.join(appPath, outputDirName, h5OutputName)
      const fileTempPath = filePath.replace(sourceDir, tempPath)
      const fileWeappPath = filePath.replace(sourceDir, weappOutputPath)
      const fileH5Path = filePath.replace(sourceDir, h5OutputPath)
      fs.existsSync(fileTempPath) && fs.unlinkSync(fileTempPath)
      fs.existsSync(fileWeappPath) && fs.unlinkSync(fileWeappPath)
      fs.existsSync(fileH5Path) && fs.unlinkSync(fileH5Path)
    })
}

export async function build (appPath, { watch, uiIndex }: IBuildOptions) {
  setBuildData(appPath, uiIndex)
  setMiniBuildData(appPath, BUILD_TYPES.WEAPP)
  buildEntry(uiIndex)
  await buildForWeapp()
  await buildForH5(uiIndex)
  if (watch) {
    watchFiles()
  }
}
