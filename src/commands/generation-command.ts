import { Injectable } from '@nestjs/common'
import { Command, CommandRunner } from 'nest-commander'
import * as fs from 'fs'
import chalk from 'chalk'

import { caseCamel, casePascal, caseKebab } from 'src/utils/case-converter'
import { runConsoleScript } from 'src/utils/run-console-script'
import { ensureDirectoryExistence, getDirectories, readFile } from 'src/utils/file-system'
import {
    CliConfig,
    CliConfigSchema,
    Other,
    OtherSchema,
    UniqueMessagesConfigElement,
    UniqueMessagesConfigSchema,
} from '../models/cli-config-schema'
import { textConst } from 'src/utils/constants'

@Injectable()
@Command({ name: 'generate', aliases: ['g'], description: 'Common file generation command' })
export class GenerationCommand extends CommandRunner {
    private loading?: {
        start: (msg?: string | undefined) => void
        stop: (msg?: string | undefined, code?: number | undefined) => void
        message: (msg?: string | undefined) => void
    }

    async run(): Promise<void> {
        const p = await import('@clack/prompts')
        const sayGoodbye = function () {
            p.outro(chalk.greenBright('Goodbye 👋'))
        }

        p.intro(chalk.black.bgHex('ffffff')(textConst.welcome))

        const configFilePath = './shinest-cli.json'
        const configRaw = readFile(configFilePath)
        if (!configRaw) throw Error(`Can not read file '${configFilePath}`)

        const config = CliConfigSchema.parse(JSON.parse(configRaw))

        const uniqueMessagesGenerationOption = 'uniqueMessages'
        const nestCliGenOption = 'nestGenerate'
        const exitOption = 'exit'
        const selectedOptionRaw = await p.select({
            message: '🛠 Select generation option',
            initialValue: '1',
            options: [
                {
                    value: uniqueMessagesGenerationOption,
                    label: 'Generate unique messages file',
                    hint: `source: ${config.generationScripts.uniqueMessages.jsonConfigFilePath}`,
                },
                ...config.generationScripts.other.map((option) => {
                    return { value: option.title }
                }),
                {
                    value: nestCliGenOption,
                    label: 'Generate with nest cli',
                    hint: 'Call global installed nest cli commands',
                },
                { value: exitOption, label: 'Exit' },
            ],
        })

        try {
            switch (selectedOptionRaw) {
                case uniqueMessagesGenerationOption:
                    await this.generateUniqueMessages(config)
                    await this.formatCodeIfNeeded(config)
                    break

                case nestCliGenOption:
                    await this.nestGenerate()
                    await this.formatCodeIfNeeded(config)
                    return

                case exitOption:
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

        await sayGoodbye()
    }

    private async nestGenerate() {
        const p = await import('@clack/prompts')

        // Dir selection
        let selectedDir: string | undefined
        const baseDir = './src'
        let currentPath = baseDir
        while (!selectedDir) {
            const dirContent = getDirectories(currentPath)
            const completeOption = 'complete'
            const prevDir = '../'

            if (currentPath !== baseDir) dirContent.push(prevDir)

            const selectedDirOption = await p.select({
                message: `Select generation folder: ${currentPath}`,
                initialValue: '1',
                options: [
                    { value: completeOption, label: `Select current dir`, hint: currentPath },
                    ...dirContent.map((folder) => {
                        return folder !== prevDir ? { value: '/' + folder } : { value: folder }
                    }),
                ],
            })

            switch (selectedDirOption) {
                case prevDir:
                    const folderNames = currentPath.split('/')
                    folderNames.pop()
                    if (folderNames.length == 0) folderNames.push('.')
                    currentPath = folderNames.join('/')
                    break

                case completeOption:
                    selectedDir = currentPath.replace(baseDir, '')
                    break

                default:
                    currentPath += String(selectedDirOption)
                    break
            }
        }

        // Nest cli command selection
        const options = { mo: 'Module', s: 'Service' } as const
        const optionsRaw = Object.keys(options) as (keyof typeof options)[]

        const selectedOptionRaw = await p.select({
            message: 'Select generation source files type',
            initialValue: '1',
            options: optionsRaw.map((optionKey) => {
                return { value: optionKey, label: options[optionKey] }
            }),
        })
        const selectedOption = selectedOptionRaw as keyof typeof options

        // Name input
        let name: string | undefined
        while (!name || name === 'undefined' || name.length < 3) {
            const input = await p.text({
                message: 'Enter name in any case',
            })
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
    }

    private async formatCodeIfNeeded(config: CliConfig) {
        if (!config.format.applyOnCommandsCompletion || !config.format.scrypt) return

        const p = await import('@clack/prompts')
        this.loading = p.spinner()
        this.loading.start('✨ Formatting in progress...')
        await runConsoleScript(config.format.scrypt)
        this.loading.stop('✨ Formatting completed')
    }

    private async generateCustomFile(config: Other, commonConfig: CliConfig) {
        const p = await import('@clack/prompts')
        let name: string | undefined

        while (!name || name === 'undefined' || name.length < 3) {
            const input = await p.text({
                message: config.nameQuestion,
            })
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
            const contentRaw = readFile(file.templateFile)
            if (!contentRaw) throw Error(`Can not read file '${file.templateFile}`)

            const content = contentRaw
                .replaceAll(placeholders.caseCamel, names.caseCamel)
                .replaceAll(placeholders.casePascal, names.casePascal)
                .replaceAll(placeholders.caseKebab, names.caseKebab)

            ensureDirectoryExistence(file.resultSourceCodeFilePath)
            fs.writeFileSync(file.resultSourceCodeFilePath, content, 'utf8')
        }

        // Update imports etc.
        for (const replacement of config.replacements) {
            const contentRaw = readFile(replacement.filePath)
            if (!contentRaw) {
                throw Error(`Can not read file '${replacement.filePath}`)
                return
            }

            const content = fs
                .readFileSync(replacement.filePath, 'utf8')
                .replaceAll(replacement.placeholder, replacement.replaceWith)

            fs.writeFileSync(replacement.filePath, content, 'utf8')
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
        const p = await import('@clack/prompts')
        this.loading = p.spinner()
        this.loading.start('Unique messages caching in progress...')

        await runConsoleScript(configUnique.cacheConfigCommand)

        this.loading.stop('Unique messages caching complete')

        this.loading = p.spinner()
        this.loading.start('Generating source code')

        const jsonString = readFile(configUnique.jsonConfigFilePath)
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
        fs.writeFileSync(configUnique.resultSourceCodeFilePath, sourceCode, 'utf8')
        this.loading.stop(
            `Source code generated: ${chalk.blue(configUnique.resultSourceCodeFilePath)}`
        )
    }
}
