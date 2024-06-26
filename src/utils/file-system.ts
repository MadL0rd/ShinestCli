import * as fs from 'fs'
import * as path from 'path'

export function ensureDirectoryExistence(filePath: string) {
    const dirname = path.dirname(filePath)
    if (fs.existsSync(dirname)) {
        return true
    }
    ensureDirectoryExistence(dirname)
    fs.mkdirSync(dirname)
}

export function readFile(filePath: string): string | undefined {
    try {
        const result = fs.readFileSync(filePath, 'utf8')
        return result
    } catch (e) {
        return undefined
    }
}

export function getDirectories(path: string) {
    return fs.readdirSync(path).filter(function (file) {
        return fs.statSync(path + '/' + file).isDirectory()
    })
}
