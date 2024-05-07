import util from 'util'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const exec = util.promisify(require('child_process').exec)

export async function runConsoleScript(script = '') {
    // try {
    const output = await exec(script)
    // console.log(output.stdout)
    // } catch (e) {
    //     console.error(e) // should contain code (exit code) and signal (that caused the termination).
    // }
}
