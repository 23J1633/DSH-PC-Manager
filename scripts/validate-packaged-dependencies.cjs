const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

async function validate(appDirectory) {
  const validator = await import(pathToFileURL(join(__dirname, 'validate-packaged-dependencies.mjs')).href)
  await validator.validatePackagedDependencies(appDirectory)
}

if (require.main === module) {
  validate(resolve(process.argv[2] || '.')).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  module.exports = async context => {
    await validate(join(context.appOutDir, 'resources', 'app'))
  }
}
