import 'reflect-metadata'

import * as p from '@clack/prompts'
import { Injectable } from '@nestjs/common'
import chalk from 'chalk'
import { statSync } from 'fs'
import * as fs from 'fs/promises'
import { Command, CommandRunner, Option } from 'nest-commander'
import path from 'path'
import { Project } from 'ts-morph'
import {
    CliConfig,
    CliConfigSchema,
    Other,
    OtherSchema,
    UniqueMessagesConfigElement,
    UniqueMessagesConfigSchema,
} from '../models/cli-config-schema.js'
import { caseCamel, caseKebab, casePascal } from '../utils/case-converter.js'
import { textConst } from '../utils/constants.js'
import { ensureDirectoryExistence } from '../utils/file-system.js'
import { runConsoleScript } from '../utils/run-console-script.js'
type GenerateCommandOptions = {
    keepOpen?: boolean
    workDir: string
}
type Path = {
    type: 'dir' | 'file'
    path: string
}
type ExtractCases<T, K extends T> = Extract<T, K>

const extensions = ['.ts', '.tsx', '.js', '.jsx']
const removeExtensions = (path: string) =>
    extensions.reduce((acc, ext) => {
        return acc.replace(ext, '')
    }, path)

@Injectable()
@Command({
    name: 'generate',
    aliases: ['g'],
    description: 'Common file generation command',
})
export class GenerationCommand extends CommandRunner {
    private workDir: string

    private loading?: {
        start: (msg?: string | undefined) => void
        stop: (msg?: string | undefined, code?: number | undefined) => void
        message: (msg?: string | undefined) => void
    }

    @Option({
        flags: '-k, --keep-open [keepOpen]',
        description: 'Keep CLI open after command',
        name: 'keepOpen',
    })
    parseKeepOpen(val?: string): boolean {
        // --keep-open            -> true
        // --keep-open false/0/no -> false
        // --keep-open true/1/yes -> true
        if (val === undefined) {
            return true
        }
        return /^(1|true|yes|y)$/i.test(val)
    }

    @Option({
        flags: '--work-dir [keepOpen]',
        description: 'Set base work directory',
        name: 'workDir',
    })
    parseWorkDir(value?: string): string {
        if (value) {
            const dir = path.resolve(value)
            const stat = statSync(dir)
            if (stat?.isDirectory()) return dir
        }

        return path.resolve('./')
    }

    async run(inputs: string[], options?: GenerateCommandOptions): Promise<void> {
        const sayGoodbye = function () {
            p.outro(chalk.greenBright('Goodbye 👋'))
        }

        p.intro(chalk.black.bgHex('ffffff')(textConst.welcome))

        const configFilePath = './shinest-cli.json'
        const configRaw = await fs.readFile(configFilePath, 'utf8')
        if (!configRaw) throw Error(`Can not read file '${configFilePath}`)

        const config = CliConfigSchema.parse(JSON.parse(configRaw))
        this.workDir = options?.workDir ?? this.parseWorkDir(config.baseDir)

        const optionIds = {
            uniqueMessages: 'uniqueMessages',
            nestGenerate: 'nestGenerate',
            removeSourceCode: 'removeSourceCodeFiles',
            exit: 'exit',
        } as const
        const selectedOptionRaw = await p.select({
            message: '🛠 Select generation option',
            initialValue: '1',
            options: [
                {
                    value: optionIds.uniqueMessages,
                    label: 'Generate unique messages file',
                    hint: `source: ${config.generationScripts.uniqueMessages.jsonConfigFilePath}`,
                },
                ...config.generationScripts.other.map((option) => {
                    return { value: option.title }
                }),
                {
                    value: optionIds.removeSourceCode,
                    label: 'Remove TS source code files',
                    hint: 'Removes file or all TS files in folder: 1) Recursively get all ts files from folder; 2) Removes all imports of those files; 3) Remove all selected files',
                },
                {
                    value: optionIds.nestGenerate,
                    label: 'Generate with nest cli',
                    hint: 'Call global installed nest cli commands',
                },
                { value: optionIds.exit, label: 'Exit' },
            ],
        })

        try {
            switch (selectedOptionRaw) {
                case optionIds.uniqueMessages:
                    await this.generateUniqueMessages(config)
                    await this.formatCodeIfNeeded(config)
                    break

                case optionIds.nestGenerate:
                    if (await this.nestGenerate()) {
                        await this.formatCodeIfNeeded(config)
                    }
                    break

                case optionIds.removeSourceCode:
                    let filePath = await this.pickPath({
                        expectedDirType: 'fileOrFolder',
                    })
                    if (!filePath) break
                    filePath = filePath
                    await this.removeImports(filePath)

                    break

                case optionIds.exit:
                    sayGoodbye()
                    return

                default:
                    const selectedOption = config.generationScripts.other.find(
                        (option) => option.title === selectedOptionRaw
                    )
                    if (!selectedOption) {
                        sayGoodbye()
                        return
                    }
                    await this.generateCustomFile(selectedOption, config)

                    break
            }
        } catch (e) {
            this.loading?.stop()
            p.cancel(`${e}`)
            return
        }

        if (options?.keepOpen) return this.run(inputs, options)

        sayGoodbye()
    }

    private async collectFilesRecursive(dir: string): Promise<string[]> {
        const result: string[] = []
        const stack: string[] = [dir]

        while (stack.length > 0) {
            const currentDir = stack.pop()!
            const entries = await fs.readdir(currentDir, { withFileTypes: true })

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name)

                if (entry.isDirectory()) {
                    stack.push(fullPath)
                } else if (entry.isFile()) {
                    result.push(fullPath)
                }
            }
        }

        return result
    }

    async removeImports(targetPath: string, baseProjectDir: string = this.workDir) {
        const targetPathStat = await fs.stat(targetPath).catch((e) => console.error(e))
        if (!targetPathStat) return

        const filePathsToRemove: string[] = targetPathStat.isFile()
            ? [targetPath]
            : targetPathStat.isDirectory()
              ? await this.collectFilesRecursive(targetPath)
              : []

        const getFileName = (filePath: string) => {
            const lastPathComponent = filePath.split('/').pop()
            return lastPathComponent ? removeExtensions(lastPathComponent) : ''
        }

        const filesToRemove = filePathsToRemove.map((filePath) => ({
            fileName: getFileName(filePath),
            path: filePath,
            pathResolved: path.resolve(filePath),
        }))
        {
            const indexFolderFile = filesToRemove.find((file) => file.fileName?.startsWith('index'))
            if (indexFolderFile) {
                const pathComponents = indexFolderFile.pathResolved.split('/').slice(0, -1)
                const folder = pathComponents.join('/')
                filesToRemove.push({
                    fileName: pathComponents[pathComponents.length - 1],
                    path: folder,
                    pathResolved: folder,
                })
            }
        }

        const project = new Project({
            tsConfigFilePath: 'tsconfig.json',
        })
        project.addSourceFilesAtPaths(`${baseProjectDir}/**/*.ts`)

        const sourceFiles = project.getSourceFiles()

        type RemovedImportFullPath = string
        type FilesWhereImportWasRemoved = { path: string; imports: string[] }[]
        const metadata: Map<RemovedImportFullPath, FilesWhereImportWasRemoved> = new Map()

        for (const sourceFile of sourceFiles) {
            let changed = false
            const sourceFilePathResolved = sourceFile.getFilePath()

            if (filesToRemove.some((file) => file.pathResolved === sourceFilePathResolved)) continue

            if (sourceFilePathResolved.endsWith('self-employed-phone-number-check.service.ts')) {
                console.log('test')
            }

            const importDeclarations = sourceFile.getImportDeclarations()

            for (const importDecl of importDeclarations) {
                const importPath = importDecl.getModuleSpecifierValue()
                const importPathFileName = getFileName(importPath)

                if (filesToRemove.some((file) => file.fileName === importPathFileName) === false) {
                    continue
                }

                const importPathResolved = await this.resolveImportToAbsolutePath(
                    importPath,
                    sourceFilePathResolved
                )
                if (!importPathResolved) continue

                if (filesToRemove.some((file) => file.pathResolved === importPathResolved)) {
                    const importingEntities = [
                        importDecl.getDefaultImport()?.getText(),
                        importDecl.getNamedImports().map((named) => named.getName()),
                    ].filter(Boolean) as string[]

                    importDecl.remove()
                    changed = true

                    if (!metadata.has(importPathResolved)) {
                        metadata.set(importPathResolved, [
                            {
                                path: sourceFilePathResolved,
                                imports: importingEntities,
                            },
                        ])
                    } else {
                        metadata.get(importPathResolved)?.push({
                            path: sourceFilePathResolved,
                            imports: importingEntities,
                        })
                    }
                }
            }

            if (changed) await sourceFile.save()
        }

        for (const fileToRemovePath of metadata.keys()) {
            const removedImports = metadata.get(fileToRemovePath)
            if (!removedImports) continue
            removedImports.sort()
            console.log(
                [
                    '',
                    `⚠️  Imports of '${chalk.green(fileToRemovePath)}' removed from:`,
                    removedImports
                        .map((item) =>
                            [
                                item.imports.length > 0
                                    ? chalk.gray(`\t▼ { ${item.imports.join(', ')} }`)
                                    : null,
                                chalk.blue(`▶︎\t${item.path}`),
                            ]
                                .filter(Boolean)
                                .join('\n')
                        )
                        .join('\n'),
                ].join('\n')
            )
        }

        await fs.rm(targetPath, { recursive: true, force: true })
        if (targetPathStat.isFile()) {
            console.log(`\n⚠️ Removed file:\n${chalk.blue('▶︎\t' + targetPath)}`)
        } else {
            console.log(
                [
                    '',
                    '⚠️ Removed directory:',
                    targetPath,
                    '',
                    'Removed files:',
                    filePathsToRemove.map((item) => chalk.blue(`▶︎\t${item}`)).join('\n'),
                    '',
                ].join('\n')
            )
        }
    }

    private async resolveImportToAbsolutePath(
        importPath: string,
        sourceFilePath: string
    ): Promise<string | null> {
        if (importPath.startsWith('src')) importPath = importPath.replace('src', this.workDir)

        const sourceDir = path.dirname(sourceFilePath)
        const basePath = path.resolve(sourceDir, importPath)

        const resolved = await this.tryResolveFile(basePath)
        if (resolved) return resolved

        const indexResolved = this.tryResolveFile(path.join(basePath, 'index'))
        if (indexResolved) return indexResolved

        return null
    }

    private async tryResolveFile(basePath: string): Promise<string | null> {
        basePath = removeExtensions(basePath)
        for (const ext of extensions) {
            const filePath = basePath + ext
            const stat = await fs.stat(filePath).catch(() => null)
            if (stat?.isFile()) return filePath
        }
        return null
    }

    private async nestGenerate(dir?: string, option?: 'mo' | 's'): Promise<boolean> {
        // Dir selection
        let selectedDir = dir
            ? option
                ? dir
                : await this.pickPath({
                      expectedDirType: 'folder',
                      currentPath: dir,
                  })
            : await this.pickPath({
                  expectedDirType: 'folder',
              })
        if (!selectedDir) return false

        // Nest cli command selection
        const selectedOption = await p.select<'s' | 'mo'>({
            message: 'Select generation source files type',
            initialValue: 's',
            options: [
                {
                    value: 's',
                    label: 'Service',
                },
                {
                    value: 'mo',
                    label: 'Module',
                },
            ],
        })
        if (p.isCancel(selectedOption)) return this.nestGenerate(selectedDir)

        // Name input
        let name: string | undefined
        while (!name || name === 'undefined' || name.length < 3) {
            const input = await p.text({
                message: 'Enter name in any case',
            })
            if (p.isCancel(input)) return this.nestGenerate(selectedDir, selectedOption)
            name = String(input)
        }
        name = caseKebab(name)

        let command: string
        switch (selectedOption) {
            case 'mo':
                command = `nest g mo ${selectedDir}/${name}`
                break
            case 's':
                command = `nest g s ${selectedDir}/${name} --no-spec`
                break
        }

        // Command call
        p.note(command, 'Result command:')
        await runConsoleScript(command, true)
        return true
    }

    private async pickPath(args: {
        expectedDirType: 'file' | 'folder' | 'fileOrFolder'
        baseDir?: string
        currentPath?: string
    }): Promise<string | false> {
        const { expectedDirType } = args
        const baseDir = args.baseDir ?? this.workDir
        let currentPath = args.currentPath ?? baseDir
        let selectedPath: string | undefined
        let initialOption: string | undefined
        {
            const stat = await fs.stat(currentPath)
            if (stat.isFile()) {
                const parts = currentPath.split('/')
                initialOption = '/' + parts.pop()
                if (parts.length === 0) parts.push('.')
                currentPath = parts.join('/')
            }
        }

        const colorByItemType: Record<
            Path['type'],
            ExtractCases<keyof typeof chalk, 'yellowBright' | 'greenBright' | 'blueBright'>
        > = {
            dir: 'blueBright',
            file: 'greenBright',
        }
        const labelPrefixByItemType: Record<Path['type'], string> = {
            dir: '📂',
            file: '📑',
        }

        while (!selectedPath) {
            let dirContent = await this.getDirContent(currentPath)
            if (expectedDirType === 'folder') {
                dirContent = dirContent.filter((value) => value.type !== 'file')
            }

            const prevDir = '../'
            const optionSelectCurrentFolder = 'optionSelectCurrentFolder'

            const options: p.Option<string>[] = [
                currentPath === baseDir
                    ? null
                    : {
                          value: prevDir,
                          label: chalk.yellow(`▲ ${prevDir}`),
                      },

                expectedDirType === 'file'
                    ? null
                    : {
                          value: optionSelectCurrentFolder,
                          label: 'Select current folder',
                          hint: currentPath,
                      },

                ...dirContent.map((item) => ({
                    value: '/' + item.path,
                    label: [
                        labelPrefixByItemType[item.type],
                        chalk[colorByItemType[item.type]](item.path),
                    ].join(' '),
                })),
            ].filter((value) => value !== null)

            const selectedOption = await p.select({
                message: `Directory selection\nCurrent path: ${chalk.greenBright(currentPath)}`,
                initialValue:
                    initialOption ??
                    (expectedDirType === 'file'
                        ? dirContent[0]
                            ? '/' + dirContent[0].path
                            : prevDir
                        : optionSelectCurrentFolder),
                options,
            })
            initialOption = undefined

            if (p.isCancel(selectedOption) || selectedOption === prevDir) {
                if (currentPath === baseDir) return false
                const parts = currentPath.split('/')
                parts.pop()
                if (parts.length === 0) parts.push('.')
                currentPath = parts.join('/')
                continue
            } else if (expectedDirType !== 'file' && selectedOption === optionSelectCurrentFolder) {
                const stat = await fs.stat(currentPath)
                if (expectedDirType === 'fileOrFolder' || stat.isDirectory()) {
                    selectedPath = currentPath
                }
            } else {
                currentPath += String(selectedOption)
                if (expectedDirType !== 'folder') {
                    const stat = await fs.stat(currentPath)
                    if (stat.isFile()) selectedPath = currentPath
                }
            }
        }

        const pathResolved = path.resolve(selectedPath)
        return pathResolved
    }

    /**
     * @param path file system path
     * @returns file names and dirs names array sorted by type then by name
     */
    private getDirContent(path: string): Promise<Path[]> {
        return fs.readdir(path, { withFileTypes: true }).then((items) => {
            const content = items.map(
                (item) => ({ type: item.isFile() ? 'file' : 'dir', path: item.name }) satisfies Path
            )
            content.sort((x1, x2) => x1.path.localeCompare(x2.path))
            return [
                ...content.filter((item) => item.type === 'dir'),
                ...content.filter((item) => item.type === 'file'),
            ]
        })
    }

    private async formatCodeIfNeeded(config: CliConfig) {
        if (!config.format.applyOnCommandsCompletion || !config.format.scrypt) return

        this.loading = p.spinner()
        this.loading.start('✨ Formatting in progress...')
        await runConsoleScript(config.format.scrypt)
        this.loading.stop('✨ Formatting completed')
    }

    private async generateCustomFile(config: Other, commonConfig: CliConfig) {
        let name: string | undefined

        while (!name || name === 'undefined' || name.length < 3) {
            const input = await p.text({
                message: config.nameQuestion,
            })
            if (p.isCancel(input)) return
            name = String(input)
        }

        this.loading = p.spinner()
        this.loading.start('Generating source code')

        // Replace variables with names
        const placeholders = config.namePlaceholders
        const names = {
            caseCamel: caseCamel(name),
            casePascal: casePascal(name),
            caseKebab: caseKebab(name),
        }
        const configString = JSON.stringify(config)
            .replaceAll(placeholders.caseCamel, names.caseCamel)
            .replaceAll(placeholders.casePascal, names.casePascal)
            .replaceAll(placeholders.caseKebab, names.caseKebab)
        config = OtherSchema.parse(JSON.parse(configString))
        config.namePlaceholders = placeholders

        // Create files
        for (const file of config.createFiles) {
            const contentRaw = await fs.readFile(file.templateFile, 'utf8')
            if (!contentRaw) throw Error(`Can not read file '${file.templateFile}`)

            const content = contentRaw
                .replaceAll(placeholders.caseCamel, names.caseCamel)
                .replaceAll(placeholders.casePascal, names.casePascal)
                .replaceAll(placeholders.caseKebab, names.caseKebab)

            ensureDirectoryExistence(file.resultSourceCodeFilePath)
            await fs.writeFile(file.resultSourceCodeFilePath, content, 'utf8')
        }

        // Update imports etc.
        for (const replacement of config.replacements) {
            const contentRaw = fs.readFile(replacement.filePath)
            if (!contentRaw) {
                throw Error(`Can not read file '${replacement.filePath}`)
                return
            }

            const content = await fs
                .readFile(replacement.filePath, 'utf8')
                .then((content) =>
                    content.replaceAll(replacement.placeholder, replacement.replaceWith)
                )

            await fs.writeFile(replacement.filePath, content, 'utf8')
        }

        const createdFiles = config.createFiles
            .map((file) => chalk.blue(file.resultSourceCodeFilePath))
            .join()
        this.loading.stop(`Source code generated: ${createdFiles}`)

        // Format source code
        await this.formatCodeIfNeeded(commonConfig)

        // Commit changes
        if (!config.git) return
        const shouldCommit = await p.confirm({
            message: `👀 Commit changes? Message: ${config.git.commitMessage}`,
        })
        if (shouldCommit !== true) return

        await runConsoleScript(`git add . && git commit -m "${config.git.commitMessage}"`)
    }

    private async generateUniqueMessages(config: CliConfig) {
        const configUnique = config.generationScripts.uniqueMessages
        this.loading = p.spinner()
        this.loading.start('Unique messages caching in progress...')

        await runConsoleScript(configUnique.cacheConfigCommand)

        this.loading.stop('Unique messages caching complete')

        this.loading = p.spinner()
        this.loading.start('Generating source code')

        const jsonString = await fs.readFile(configUnique.jsonConfigFilePath, 'utf8')
        if (!jsonString) throw Error(`Can not read file '${configUnique.jsonConfigFilePath}`)

        const uniqueMessagesJson = JSON.parse(jsonString)
        const uniqueMessages = UniqueMessagesConfigSchema.parse(uniqueMessagesJson)

        type GroupContent = {
            haveParams: boolean
            uniqueMessages: UniqueMessagesConfigElement[]
        }
        const groups: Record<string, GroupContent> = {}

        for (const item of uniqueMessages) {
            if (!groups[item.group]) {
                groups[item.group] = {
                    haveParams: false,
                    uniqueMessages: [],
                }
            }
            groups[item.group].uniqueMessages.push(item)
            if (item.params.length > 0) {
                groups[item.group].haveParams = true
            }
        }
        const groupNames = Object.keys(groups)

        let sourceCode = `
// ==================
// * Generated file *
// ==================`
        sourceCode += '\n\n'

        // base type
        sourceCode += 'export class UniqueMessagePrimitive {\n'
        sourceCode += groupNames
            .map((name) => `readonly ${caseCamel(name)} = new ${casePascal(name)}()`)
            .join('\n')
        sourceCode += '}\n'

        // base type with params
        sourceCode += 'export class UniqueMessageWithParams {'
        sourceCode += groupNames
            .map(
                (name) =>
                    `readonly ${caseCamel(name)}: ${casePascal(name)}${groups[name].haveParams ? 'WithParams' : ''}`
            )
            .join('\n')
        sourceCode += '\n\n'

        sourceCode += `constructor(private readonly base: UniqueMessagePrimitive) {`
        sourceCode += groupNames
            .map(
                (name) =>
                    `this.${caseCamel(name)} = ${groups[name].haveParams ? `new ${casePascal(name)}WithParams(base.${caseCamel(name)})` : `base.${caseCamel(name)}`}`
            )
            .join('\n')

        sourceCode += '}\n}\n\n'

        for (const groupName of groupNames) {
            const className = casePascal(groupName)
            sourceCode += `export class ${className} {`
            sourceCode += groups[groupName].uniqueMessages
                .map((uniqueMessage) => {
                    const comment = uniqueMessage.comment
                        ? `/**\n * @description ${uniqueMessage.comment.replaceAll('\n', '\n * ')}\n*/\n`
                        : ''
                    return `${comment}readonly ${caseCamel(uniqueMessage.key)} = ${JSON.stringify(uniqueMessage.value)}`
                })
                .join('\n')
            sourceCode += '}\n'

            if (groups[groupName].haveParams === false) {
                sourceCode += '\n'
                continue
            }

            // params
            sourceCode += `export class ${className}WithParams {\nconstructor(private readonly base: ${className}) {}\n`
            sourceCode += groups[groupName].uniqueMessages
                .map((uniqueMessage) => {
                    const value = uniqueMessage.value.replaceAll('\n', '\\n')
                    let result = `/**\n * @value: ${value}\n`
                    result += uniqueMessage.comment
                        ? ` * @description ${uniqueMessage.comment.replaceAll('\n', '\n * ')}\n`
                        : ''
                    result += ` */\n`

                    if (uniqueMessage.params.length === 0) {
                        result += `get ${uniqueMessage.key}(): string { return this.base.${uniqueMessage.key} }`
                    } else {
                        result += `${uniqueMessage.key}(args: {`
                        result += uniqueMessage.params
                            .map((param) => `${param.name}: ${param.type}`)
                            .join()
                        result += `}): string { return this.base.${uniqueMessage.key}\n`
                        result += uniqueMessage.params
                            .map(
                                (param) =>
                                    `.replaceAll('${param.name}', \`$\{args.${param.name}}\`)`
                            )
                            .join('\n')
                        result += '}'
                    }
                    return result
                })
                .join('\n')
            sourceCode += '}\n\n'
        }

        ensureDirectoryExistence(configUnique.resultSourceCodeFilePath)
        await fs.writeFile(configUnique.resultSourceCodeFilePath, sourceCode, 'utf8')
        this.loading.stop(
            `Source code generated: ${chalk.blue(configUnique.resultSourceCodeFilePath)}`
        )
    }
}
