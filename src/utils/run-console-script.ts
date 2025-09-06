import { exec as execCb } from 'child_process'
import util from 'util'

const exec = util.promisify(execCb)

export async function runConsoleScript(script = '', logStdout: boolean = false) {
    // try {
    const output = await exec(script)
    if (logStdout) console.log(output.stdout)
    // } catch (e) {
    //     console.error(e) // should contain code (exit code) and signal (that caused the termination).
    // }
}
